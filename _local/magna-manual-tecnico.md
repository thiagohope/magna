# Manual Técnico — Magna Art (magnaleite.com)

**Projeto:** Galeria de arte online da artista Magna Leite
**Servidor:** `brainboxmed-server-01` (DigitalOcean), ficheiros em `/home/brainboxmed/magna/`
**Última revisão deste manual:** Setembro 2026, a partir do código-fonte real do projeto

> Este manual foi escrito para alguém que nunca viu o projeto mas sabe programar. Cada secção explica não só o "como" mas o "porquê" — sobretudo onde as regras parecem arbitrárias à primeira vista (ex: por que certos JSON nunca vão por Git). Uma secção separada, perto do fim, lista inconsistências e riscos reais encontrados no código atual — não assuma que "está em produção" significa "está correto".

> **Nota de atualização (Setembro 2026):** os pontos 1 a 6 da secção 9 já foram corrigidos no código local (`save-artworks.js`, `admin/magna-manager-x9z2-safe.html`, `_local/nginx-brainboxmed.conf`). **Estas correções ainda não estão em produção** — falta fazer deploy (ver secção 7/8) e aplicar os blocos Nginx novos no servidor, nos dois vhosts. Este manual já descreve o comportamento *corrigido*; se o site ainda não tiver recebido o deploy, o comportamento real em produção pode ainda ser o antigo.

---

## Índice

1. [Visão geral da arquitetura](#1-visão-geral-da-arquitetura)
2. [Como adicionar/editar uma obra](#2-como-adicionareditar-uma-obra)
3. [Como gerir coleções](#3-como-gerir-coleções)
4. [Como criar e aplicar Price Tiers](#4-como-criar-e-aplicar-price-tiers)
5. [Como alterar preços — o fluxo completo com o Stripe](#5-como-alterar-preços--o-fluxo-completo-com-o-stripe)
6. [QR Codes — como funcionam e onde editar](#6-qr-codes--como-funcionam-e-onde-editar)
7. [Deployment — o que vai por Git, o que vai por SCP, e porquê](#7-deployment--o-que-vai-por-git-o-que-vai-por-scp-e-porquê)
8. [Configuração do servidor — PM2, variáveis de ambiente, Nginx](#8-configuração-do-servidor--pm2-variáveis-de-ambiente-nginx)
9. [⚠️ Inconsistências, riscos e pontos frágeis identificados](#9-️-inconsistências-riscos-e-pontos-frágeis-identificados)
10. [Checklist de segurança](#10-checklist-de-segurança)
11. [Apêndice — mapa de ficheiros e endpoints](#11-apêndice--mapa-de-ficheiros-e-endpoints)

---

## 1. Visão geral da arquitetura

O site é **estático** (HTML/CSS/JS puro, sem framework de build) servido diretamente pelo Nginx. A única parte dinâmica é um pequeno servidor Node.js (`save-artworks.js`) cuja única função é **escrever ficheiros JSON e falar com o Stripe** — ele não serve páginas nem faz renderização nenhuma.

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (visitante)                                                 │
│  index.html ──▶ artwork.html ──▶ verify.html / certificate.html      │
│  (lê artworks.json, collections.json diretamente via fetch)          │
└───────────────────────────────┬───────────────────────────────────┘
                                 │ HTTPS
┌────────────────────────────────▼──────────────────────────────────┐
│  NGINX  (brainboxmed-server-01, portas 80/443)                     │
│                                                                     │
│  location /magna              → alias /home/brainboxmed/magna/     │
│                                   (serve HTML, JSON, assets, tudo   │
│                                    estático diretamente do disco)   │
│                                                                     │
│  location /magna/api/*        → proxy_pass 127.0.0.1:3100/*        │
│                                   (um location block por endpoint)  │
└───────────────────────────────┬────────────────────────────────────┘
                                 │ 127.0.0.1:3100 (só localhost, nunca exposto)
┌────────────────────────────────▼────────────────────────────────────┐
│  NODE.JS — save-artworks.js  (gerido por PM2, processo "magna-api") │
│                                                                      │
│  • Verifica header X-Magna-Secret em cada pedido de escrita          │
│  • Escreve artworks.json / collections.json / price-tiers.json /     │
│    exhibitions.json diretamente no disco (atomically: .tmp + rename) │
│  • Faz backup automático antes de cada escrita (backups/, últimos 20)│
│  • Fala com a API do Stripe (live + test) para trocar preços         │
│  • Recebe uploads de imagem em base64 e grava em assets/             │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  ADMIN — admin/magna-manager-x9z2-safe.html                          │
│  Página estática igual a qualquer outra (servida pelo mesmo Nginx),  │
│  usada só localmente por ti. Faz fetch/POST para os endpoints acima  │
│  usando o header X-Magna-Secret. Também fala diretamente com o       │
│  Stripe através do backend (nunca com a chave secreta no browser).   │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  STRIPE  — Payment Links fixos por obra/variação                     │
│  Guardados em artworks.json (priceOriginal.live/test, etc.)          │
│  O botão "Comprar" no artwork.html aponta diretamente para estes     │
│  URLs — não há Checkout Session dinâmica, não há webhook.            │
└──────────────────────────────────────────────────────────────────────┘
```

**Pontos-chave da arquitetura:**

- **Não há base de dados.** Tudo o que parece "dados" (obras, coleções, tiers, exposições) é um ficheiro `.json` no disco do servidor, servido como ficheiro estático pelo Nginx e editado através de um pequeno backend que só sabe reescrever esses ficheiros.
- **O backend nunca é acedido diretamente pelo público.** `save-artworks.js` escuta em `127.0.0.1:3100` — não tem IP público, não tem porta aberta na firewall. Só é alcançável através do Nginx, que decide (via `location` blocks) que pedidos deixa passar.
- **A autenticação é um segredo partilhado**, não OAuth/sessões/cookies: o header `X-Magna-Secret` tem de bater certo com a variável de ambiente `MAGNA_API_SECRET` do processo PM2. Qualquer pedido de escrita sem esse header correto é rejeitado com 403.
- **O admin (`magna-manager-x9z2-safe.html`) não é uma aplicação separada** — é só mais uma página HTML estática, servida pelo mesmo Nginx que serve o site público, e o "login" que vês ao abri-la é puramente cosmético (ver secção 9, ponto 3). A proteção real dos dados está inteiramente no `X-Magna-Secret`.
- **Existem dois domínios/vhosts Nginx**: `brainboxmed.com` (com o site em `/magna`) e, segundo o logbook do projeto, também `magnaleite.com` como vhost próprio. **Isto é crítico para deployment** — ver secção 8.

---

## 2. Como adicionar/editar uma obra

1. Abre `admin/magna-manager-x9z2-safe.html` no browser (localmente, ou pelo URL de produção se precisares fora de casa).
2. No ecrã de login, introduz o **`MAGNA_API_SECRET`** (o mesmo valor que está em `ecosystem.config.js` no servidor) — já não existe uma password separada. O valor introduzido é validado ao vivo contra o servidor (`GET /magna/api/verify-secret`); só desbloqueia a interface se o servidor confirmar que está correto. Com **"Guardar neste dispositivo"** marcado (por omissão), o secret fica guardado em `localStorage` desse browser e não precisas de o reintroduzir nas próximas vezes — cada vez que abres a página, ele é revalidado automaticamente contra o servidor (se entretanto tiveres rodado o secret, é pedido de novo). Desmarcando a opção, fica só em `sessionStorage` (esquecido ao fechar a aba). Usa o link **"Sair"** no cabeçalho para esquecer o secret guardado neste dispositivo (ex. num computador partilhado).
3. Clica **"↓ Carregar do Servidor"** — isto faz `fetch` a `artworks.json`, `collections.json` e `price-tiers.json` diretamente (não passa pelo backend Node, só lê os ficheiros estáticos). **Faz sempre isto primeiro**: se editares sem carregar, o `saveToServer()` escreve por cima do que estiver em memória (que pode estar vazio ou desatualizado) e pode apagar obras de outra pessoa que tenha editado entretanto.
4. No dropdown "Selecionar Obra", escolhe uma obra existente para editar, ou "Criar Nova Obra".
   - Ao criar nova obra, o campo **Slug** fica editável — este é o identificador único (chave do objeto em `artworks.json`) e também aparece em URLs (`artwork.html?id=<slug>`, `verify.html?id=<slug>`). Usa só minúsculas, números e hífens. **Depois de gravado, não mudes o slug** — quebra qualquer link/QR/certificado já emitido para essa obra.
   - Ao editar uma obra existente, o slug fica bloqueado (read-only) de propósito, precisamente para evitar este erro.
5. Preenche os campos: título, ano, dimensões, técnica (PT/EN/ES), história/texto (PT/EN/ES), localização, estado (`available` / `sold_private` / `sold_public`).
6. **Imagem**: arrasta ou clica na drop-zone para escolher o ficheiro full-res. Depois clica **"⬆ Enviar Imagens (Servidor + Local)"**:
   - Gera automaticamente uma thumbnail de 800px de largura no próprio browser (via `<canvas>`).
   - Pergunta onde guardar: só servidor, só local, ou ambos. "Local" usa a File System Access API do Chrome/Edge para escrever diretamente numa pasta do teu computador (útil para manter uma cópia local das imagens, já que elas nunca vão por Git — ver secção 7).
   - Se escolheres "servidor" ou "ambos", a imagem é enviada em base64 para `/upload-painting-image`, que grava em `assets/paintings/full/<ficheiro>` e `assets/paintings/thumbnails/<ficheiro>`. Se a imagem full-res tiver um slug associado, o servidor copia-a automaticamente também para `assets/downloads/<slug>-print.<ext>` (usado na página de download digital).
   - Antes de enviar, o admin verifica no servidor (`GET /check-image`) se já existe um ficheiro com esse nome e, se existir, pergunta se queres substituir. Reenviar com o mesmo nome sem confirmar substitui a imagem antiga.
7. **Preços públicos** (`priceDisplay`): os 4 valores (Original, Gallery Print, Collector Print, Digital) que aparecem no site. Podes preenchê-los à mão ou usar um Price Tier (secção 4) para os calcular automaticamente.
8. **Links de Pagamento (Stripe)**: cola aqui os URLs dos Payment Links (test e live) criados manualmente no dashboard do Stripe para cada variação. Isto é o que liga o botão "Comprar" do `artwork.html` ao checkout real — ver secção 5 para o fluxo completo.
9. **Coleções**: seleciona as pills das coleções a que a obra pertence (ver secção 3).
10. **Histórico de Proveniência**: linhas de evento (Criação, Exposição, Venda, Restauro, Certificação) com data/local/detalhes — aparece no certificado da obra.
11. Clica **"💾 GUARDAR NO SERVIDOR"**. Isto:
    - Junta todos os campos do formulário num objeto e mete-o em `globalArtworks[slug]`.
    - Envia **o objeto `artworks.json` inteiro** (todas as obras, não só a que editaste) via `POST /magna/api/save-artworks`, com o header `X-Magna-Secret`.
    - O backend faz backup do `artworks.json` anterior, depois escreve o novo ficheiro de forma atómica (escreve num `.tmp` e só depois faz `rename` — evita ficar com um JSON a meio escrito se o processo cair a meio).
    - Em paralelo, tenta também gravar `collections.json` (ver secção 3, porque pode ter havido coleções novas auto-registadas).
12. Se preferires não gravar diretamente (ex: queres rever antes, ou o servidor está em baixo), usa **"Gerar JSON"** — produz o snippet para colares manualmente, ou **"⬇ Exportar artworks.json"** para descarregar o ficheiro completo.

**Porquê gravar o objeto inteiro em vez de só a obra editada?** Porque o backend não faz *merge* — o endpoint `/save-artworks` substitui `artworks.json` por inteiro pelo corpo do pedido. Isto simplifica muito o backend (não precisa de lógica de merge/lock), mas significa que **duas pessoas a editar ao mesmo tempo a partir de dados desatualizados podem apagar o trabalho uma da outra**. Não há hoje nenhum mecanismo de lock ou deteção de conflito — é uma responsabilidade manual (carregar sempre do servidor antes de editar, e idealmente ser só uma pessoa a editar de cada vez).

---

## 3. Como gerir coleções

Coleções são etiquetas/categorias (ex: `setubal`, `alentejo`, `nature`) usadas para filtrar obras no site. Vivem em `collections.json`, como um dicionário `{ id: { pt, en } }`.

**Duas formas de gerir:**

1. **A partir do formulário de uma obra** — botão **"⚙ Gerir coleções"** dentro da secção "Coleções". Aqui podes:
   - Editar o nome PT/EN de uma coleção existente.
   - Apagar uma coleção — **isto remove-a de todas as obras que a usam, em cascata, e não pode ser desfeito.** O modal mostra quantas obras seriam afetadas antes de confirmares.
   - Ver coleções "órfãs" (marcadas com ⚠) — IDs que aparecem em alguma obra mas nunca foram registados com nome PT/EN em `collections.json` (normalmente porque foram criados fora do fluxo normal, ou por um bug antigo de sincronização — ver `technical-learnings` do projeto).
2. **Criar uma coleção nova** — formulário "Nova coleção" (ID, Nome PT, Nome EN), sempre visível no formulário da obra. O ID é normalizado automaticamente (minúsculas, sem acentos, espaços viram hífens). A nova coleção é automaticamente associada à obra que estás a editar nesse momento.

**Cada alteração a coleções é gravada imediatamente no servidor** (`POST /magna/api/save-collections`), independentemente de teres clicado "Guardar no Servidor" no formulário da obra — são fluxos separados. Isto é intencional (queres que uma coleção nova fique disponível logo para outras obras).

**Se algo falhar a guardar collections.json** (ex: o endpoint estar temporariamente em baixo, ou o bloco Nginx ainda não ter sido aplicado no servidor — ver secção 8), o erro agora aparece sempre na barra de estado, de forma persistente (não desaparece sozinho como as mensagens de sucesso). Usa o botão **"🔄 Sincronizar Coleções"** no cabeçalho para recuperar: ele recalcula `collections.json` a partir de todas as obras atualmente carregadas (registando automaticamente qualquer coleção "órfã") e tenta gravar de novo no servidor. É a ferramenta a usar sempre que suspeitares que `collections.json` ficou dessincronizado das obras.

**Porquê `collections.json` nunca vai por Git?** Ver secção 7 — a mesma regra de "dados gerados/editados em runtime nunca são versionados" aplica-se aqui tal como a `artworks.json`.

---

## 4. Como criar e aplicar Price Tiers

Um **Price Tier** é um atalho: defines só o preço do "Original", e o sistema calcula os outros três automaticamente:

| Variação | Fórmula |
|---|---|
| Original | valor que introduzes |
| Gallery Print | 30% do Original |
| Collector Print | 10% do Original |
| Digital | 1% do Original |

(ver `computeTierPrices()` no admin — estas percentagens estão hardcoded no HTML, não configuráveis pela interface.)

**Gerir tiers:** botão **"⚙ Gerir Tiers"** (dentro do modal "Aplicar Tier de Preço", ou diretamente). Podes criar, editar e apagar tiers — cada ação grava imediatamente `price-tiers.json` no servidor via `POST /magna/api/save-price-tiers`. Apagar um tier **não** afeta obras que já tenham esse preço aplicado (o tier é só uma "receita" para calcular preços, não uma referência viva).

**Aplicar um tier a obras:**
1. Botão **"🏷 Aplicar Tier de Preço"** no topo da página.
2. Marca as obras (há um botão "Selecionar todas").
3. Escolhe o tier na dropdown.
4. **"Aplicar às selecionadas"** — isto só altera `priceDisplay` **em memória**, no browser. Nada é gravado ainda.
5. Para persistir, tens de clicar **"💾 GUARDAR NO SERVIDOR"** depois (o mesmo botão da secção 2) — isto grava `artworks.json` com os novos `priceDisplay`.
6. Nesse momento, o botão **"🔒 Confirmar no Stripe (N)"** no topo fica ativo, com N = número de obras com alterações de tier pendentes de refletir no Stripe. Isto é intencional: **aplicar um tier e gravar `priceDisplay` não atualiza o Stripe automaticamente** — são dois passos separados de propósito (ver secção 5, porque atualizar o Stripe é uma operação com consequências reais e não reversível automaticamente).

---

## 5. Como alterar preços — o fluxo completo com o Stripe

Isto é o fluxo mais delicado do projeto porque toca dinheiro real. Há **três coisas diferentes** que podem estar dessincronizadas se não seguires os passos por ordem:

1. `priceDisplay` em `artworks.json` — o que aparece escrito no site (`€X`).
2. Os Payment Links do Stripe (`priceOriginal.live`, etc.) — o URL para onde o botão "Comprar" aponta.
3. O **preço real** associado a esse Payment Link no Stripe — o que o cliente paga de facto no checkout.

O botão "Comprar" nunca lê o `priceDisplay` para cobrar — ele só usa o `priceDisplay` para *mostrar* um número. Quem determina o valor cobrado é o preço configurado no lado do Stripe, associado ao Payment Link. **Se só mudares o `priceDisplay` e não tocares no Stripe, o site passa a mostrar um preço errado** (o cliente vê €X mas paga o valor antigo no checkout).

### Fluxo completo, passo a passo

**A. Via Price Tier (obras em massa):**
1. Aplica um tier a uma ou mais obras (secção 4) → `priceDisplay` muda em memória.
2. **"Guardar no Servidor"** → grava `priceDisplay` em `artworks.json`. Site já mostra o novo número.
3. **"🔒 Confirmar no Stripe"** → para cada obra/variação pendente com um Payment Link (test e/ou live) preenchido, o backend:
   - Procura esse Payment Link no Stripe (por URL exato, via `paymentLinks.list` + `listLineItems`).
   - Cria um **novo** `Price` no mesmo `Product`, com o novo valor.
   - Atualiza a line item do Payment Link para apontar para o novo `Price` (o URL do Payment Link não muda).
   - Arquiva (`active: false`) o `Price` antigo.
   - Faz isto **separadamente para live e test**, se ambos os links estiverem preenchidos.
4. Um `confirm()` do browser avisa antes: *"Isto vai criar novos preços e trocar N Payment Link(s) no Stripe (live + test). Não é reversível automaticamente."* — leva isto a sério, não há "desfazer".
5. Se alguma obra falhar (ex: Payment Link não encontrado, chave Stripe não configurada), ela continua marcada como "pendente" no contador e podes tentar de novo depois de corrigir.

**B. Preço individual, fora do fluxo de tiers:**
- Podes editar `price_original` / `price_gallery` / etc. diretamente no formulário da obra e gravar — mas isto **não** ativa o botão "Confirmar no Stripe" (esse contador só é alimentado pelo fluxo de tiers, via `pendingTierSlugs`). Se editares o preço manualmente fora de um tier, tens de atualizar o Stripe **manualmente** (dashboard do Stripe: arquivar preço antigo, criar novo, editar o Payment Link) e depois colar o novo estado — não há atalho automático para este caso no admin atual.

### Porquê este processo em vez de mudar o preço "no sítio"?

O Stripe usa um **modelo de preços imutável**: um `Price` depois de criado não pode ser editado (só arquivado). É uma limitação da própria API do Stripe, não uma escolha do projeto — por isso o fluxo é sempre "criar novo, trocar referência, arquivar antigo", nunca "editar o preço existente". Isto já está documentado como fricção conhecida no histórico técnico do projeto.

### O que NÃO muda neste fluxo
- O **URL** do Payment Link nunca muda (é o mesmo link que já pode estar impresso, num QR, ou partilhado por email) — só o preço por trás dele.
- A criação do Payment Link em si (produto, imagem, nome) continua a ser feita **manualmente no dashboard do Stripe** — o admin tool nunca cria Payment Links novos, só troca o preço de um que já exista.

---

## 6. QR Codes — como funcionam e onde editar

Há **três QR codes diferentes** no site, com propósitos diferentes — não confundir:

| QR Code | Onde aparece | Aponta para | Onde se edita |
|---|---|---|---|
| **QR da galeria (geral)** | Rodapé do `index.html` (pequeno, `#siteQrCode`) e página `qrcode.html` (A4, para imprimir) | `https://magnaleite.com/` (fixo) | Constante `PUBLIC_GALLERY_URL` no `<script>` do `index.html` (linha ~702) **e** do `qrcode.html` (linha ~101) — **tens de editar os dois ficheiros se algum dia mudares o domínio**, não há uma fonte única. |
| **QR de proveniência (por obra)** | `artwork.html`, junto ao certificado de cada obra | `<BASE_URL>/verify.html?id=<slug>` — uma página de verificação de autenticidade específica daquela obra | Gerado automaticamente a partir do `slug` da obra — não há nada para editar manualmente; muda sozinho consoante a obra que estás a ver. |
| **QR de preview no Admin** | Sidebar do `magna-manager-x9z2-safe.html` ("Preview Certificado") | `<BASE_URL>/admin/certificate.html?id=<slug>` | Também automático, só para conferires visualmente antes de publicar. |

**Como funciona tecnicamente:** todos usam a mesma biblioteca client-side `qrcodejs` (carregada via CDN `cdnjs.cloudflare.com`), que desenha o QR diretamente no browser com `<canvas>`/`<table>` — não há geração no servidor, não há imagem PNG guardada em disco. Isto significa que **não existe um "editor de QR"** propriamente dito: editar um QR é sempre editar o texto/URL que ele codifica, no código-fonte da página correspondente.

**`qrcode.html` (a página A4 imprimível):**
- É pensada para ser aberta, impressa (`window.print()`, com CSS `@media print` dedicado para caber exatamente numa folha A4), e usada fisicamente (placas na galeria, cartões, convites).
- O QR aqui é de alta resolução (600×600px, `correctLevel: H` — o nível de correção de erro mais alto, importante para impressão porque tolera melhor manchas/dobras/baixa qualidade de impressão) — mais alto do que o QR pequeno do rodapé do `index.html` (72×72px, `correctLevel: M`), que só precisa de ser legível num ecrã.
- Se precisares de gerar uma nova versão para imprimir, basta abrir `qrcode.html` em produção e usar o botão de imprimir da própria página — não precisas de nenhuma ferramenta externa.

**Porquê o QR de proveniência aponta para `verify.html` e não para `artwork.html`?** Porque o propósito é diferente: `artwork.html` é a página de venda/apresentação da obra (preços, botão comprar); `verify.html` é pensada como um registo de autenticidade — o que um comprador ou colecionador usa para confirmar que uma obra física corresponde a um registo genuíno, sem necessariamente ver preços ou botões de compra.

---

## 7. Deployment — o que vai por Git, o que vai por SCP, e porquê

### A regra central

| Vai por Git | Nunca vai por Git (só SCP/WinSCP) |
|---|---|
| `index.html`, `artwork.html`, `qrcode.html`, `verify.html`, etc. (código) | `artworks.json`, `collections.json`, `exhibitions.json`, `price-tiers.json` |
| `save-artworks.js`, `package.json` | `ecosystem.config.js` (tem secrets reais) |
| `ecosystem.config.example.js` (só placeholders) | Imagens: `assets/paintings/full/`, `assets/paintings/thumbnails/`, `assets/exhibition/*`, `assets/downloads/`, `assets/img/*.{jpg,png,webp}` |
| `assets/icons/` (favicons, assinatura, logo — pequenos, fazem parte da identidade visual do código) | `backups/` (gerado pelo servidor) |

Isto está formalizado no `.gitignore` do projeto, com comentários a explicar cada bloco.

### Porquê os JSON de dados nunca vão por Git

Duas razões, ambas importantes:

1. **Concorrência de escrita.** Os JSON de dados são escritos por um processo em runtime (o `save-artworks.js`, através do admin tool) diretamente no servidor de produção. Se estivessem também no Git, terias dois "donos" do mesmo ficheiro — o `git pull` no deploy e o backend a escrever em runtime — e mais cedo ou mais tarde vais ter um conflito de merge no meio de um ficheiro JSON gerado automaticamente (o que já aconteceu neste projeto: ver a lição documentada sobre conflitos recorrentes em `artworks.json`/`exhibitions.json`, resolvida precisamente ao meter estes ficheiros no `.gitignore`).
2. **Tamanho e natureza dos dados.** Estes ficheiros mudam constantemente (cada gravação no admin reescreve o ficheiro inteiro) e não fazem sentido versionados como "código" — não vais querer 200 commits de "mudei o preço de uma obra em €10". O backup real destes dados é feito pelo próprio backend (pasta `backups/`, últimos 20 por ficheiro) e por exports manuais (`⬇ Exportar artworks.json` no admin).

**Consequência prática a que deves estar atento:** como estes ficheiros não estão no Git, **não existe histórico de versões nem rollback fácil** além dos 20 backups mais recentes guardados no próprio droplet. Se o disco do servidor falhar ou alguém apagar `backups/` por engano, o único histórico que sobra é o que tiveres exportado manualmente para o teu computador. Vale a pena, periodicamente, copiar `backups/` (ou os exports) para fora do droplet — ver secção 9, ponto 9.

### Porquê `ecosystem.config.js` fica de fora mas `ecosystem.config.example.js` fica dentro

`ecosystem.config.js` é o ficheiro real, com o `MAGNA_API_SECRET` e as chaves Stripe (live e test) em texto simples, porque é assim que o PM2 injeta variáveis de ambiente no processo. Se este ficheiro fosse commitado, essas chaves ficariam no histórico do Git para sempre (mesmo que apagues o ficheiro depois, continuam nos commits antigos) — e o repositório deste projeto, mesmo sendo privado, não é o sítio certo para segredos de produção.

`ecosystem.config.example.js` existe precisamente para resolver o problema oposto: sem ele, alguém a montar o projeto do zero (incluindo tu próprio, num servidor novo) não saberia que variáveis o processo espera. O `.example.js` documenta a forma (`MAGNA_API_SECRET`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_SECRET_KEY_TEST`) sem conter valores reais — copia-se para `ecosystem.config.js` e preenchem-se os valores reais só no servidor.

### Fluxo de deployment normal

Segundo a disciplina já estabelecida no projeto: **desenvolvimento local → teste local → commit e push → pull em produção**. A produção nunca é editada diretamente (exceto para os JSON de dados e imagens, que são sempre SCP, nunca edição manual de ficheiro no servidor). Isto evita o cenário já documentado de um `save-artworks.js` corrompido em produção com marcadores de conflito de merge por lá terem ficado alterações manuais/pulls mal resolvidos diretamente no servidor.

**Passos típicos para uma alteração de código:**
1. Editar localmente, testar (Live Server em `127.0.0.1:5500`, ou equivalente).
2. `git add` / `commit` / `push` para o remoto.
3. No servidor: `git pull`.
4. Se a alteração tocou em `save-artworks.js` (o backend): `pm2 restart magna-api` — **um `git pull` sozinho não reinicia o processo Node**, o PM2 continua a correr o código antigo até seres tu a mandá-lo recarregar.
5. Se a alteração acrescentou um **novo endpoint** ao backend: também precisas de adicionar o `location` block correspondente ao Nginx — depois `nginx -t && systemctl reload nginx`. Hoje isto só precisa de ser feito no vhost `brainboxmed`: o frontend e o admin chamam sempre `https://brainboxmed.com/magna/api/*`, mesmo quando a página está a ser vista em `magnaleite.com` (ver secção 8 para o porquê). Este passo — esquecer de adicionar o bloco Nginx a um endpoint novo — já foi a causa de pelo menos um incidente neste projeto (ver secção 9, ponto 1) e continua a ser o erro mais fácil de cometer no fluxo de deployment.

**Para os JSON de dados e imagens:** normalmente não precisam de deployment manual — são escritos diretamente pelo backend quando usas o admin tool. SCP/WinSCP só é necessário para a criação inicial de um ficheiro que ainda não existe no servidor (ex: primeira vez que se configura um novo `exhibitions.json` do zero) ou para restaurar a partir de um backup local.

---

## 8. Configuração do servidor — PM2, variáveis de ambiente, Nginx

### PM2

```bash
# Primeira vez (depois de copiar e preencher ecosystem.config.js):
pm2 start ecosystem.config.js
pm2 save                    # para sobreviver a reboot do droplet

# Rotina:
pm2 restart magna-api       # depois de qualquer alteração a save-artworks.js ou ao ecosystem.config.js
pm2 logs magna-api          # ver logs em tempo real (inclui avisos de secret errado, erros do Stripe, etc.)
pm2 stop magna-api          # parar
pm2 status                  # ver se está "online"
```

O processo chama-se `magna-api`, corre `save-artworks.js`, com `cwd: /home/brainboxmed/magna` (importante — os `path.join(__dirname, ...)` no código assumem que corre a partir desta pasta).

### Variáveis de ambiente (via `ecosystem.config.js`)

| Variável | Para quê | O que acontece se faltar |
|---|---|---|
| `MAGNA_API_SECRET` | Comparado com o header `X-Magna-Secret` em todos os endpoints de escrita | Cai no valor por omissão `'CHANGE_THIS_SECRET'` — o servidor **arranca na mesma**, só avisa na consola. Ver risco na secção 9, ponto 4. |
| `STRIPE_SECRET_KEY_LIVE` | Chave secreta do Stripe (modo produção) | O cliente Stripe live fica `null`; qualquer tentativa de atualizar preço live falha com erro claro (`'STRIPE_SECRET_KEY_LIVE não configurada'`) |
| `STRIPE_SECRET_KEY_TEST` | Chave secreta do Stripe (modo teste) | Igual, mas para o ambiente de teste |

**Nunca** cola estas chaves em `ecosystem.config.example.js`, no código do admin (`magna-manager-x9z2-safe.html`), ou em qualquer sítio que vá por Git — as chaves do Stripe só devem existir em `ecosystem.config.js` no servidor.

### Nginx

O site depende de pelo menos um `server{}` block com:
- `location /magna { alias /home/brainboxmed/magna; index index.html; try_files $uri $uri/ =404; }` — serve tudo o que é estático (HTML, JSON, imagens) diretamente do disco.
- **Um `location` block por endpoint do backend**, todos a fazer `proxy_pass` para `http://127.0.0.1:3100/<endpoint>`. Não há um único `location /magna/api/ { proxy_pass ...; }` genérico — cada endpoint tem o seu próprio bloco, com o seu próprio `client_max_body_size` (uploads de imagem precisam de limites maiores, ex. 15m, do que gravações de JSON, ex. 12m).

**Ponto crítico:** o `.gitignore` marca explicitamente que "nginx não é versionado" — a configuração do Nginx só existe no servidor (`/etc/nginx/sites-available/brainboxmed`), com uma cópia de referência guardada manualmente em `_local/nginx-brainboxmed.conf` (fora do repositório Git, só para consulta local tua). **Isto significa que qualquer alteração ao Nginx feita diretamente no servidor e não copiada de volta para essa cópia de referência fica invisível para quem só olhar para o projeto local.**

Existem **dois vhosts diferentes** — confirmado com cópias reais dos dois, ambas agora em `_local/`: `nginx-brainboxmed.conf` (para `brainboxmed.com`, onde o projeto vive em `/magna`) e `nginx-magnaleite.conf` (para `magnaleite.com`, onde o projeto vive na **raiz** do domínio — `location / { root /home/brainboxmed/magna; ... }`, sem prefixo `/magna`).

**O que isto significa na prática, depois de comparar os dois:**
- No vhost `magnaleite`, os blocos de API usam o prefixo `/api/...` (sem `/magna`) — faz sentido, já que o projeto está na raiz. Mas dois blocos (`about-photos` e `save-collections`) foram colados por engano com o prefixo `/magna/api/...`, inconsistente com o resto — esses dois nunca correspondem a nenhum pedido real nesse vhost.
- **Mais importante:** todo o código (frontend e admin) tem o domínio da API sempre fixo em `https://brainboxmed.com/magna/api/*` — nas constantes `BASE_URL`, `API_ENDPOINT`, `API_BASE`, etc. Isto é verdade **mesmo quando a página está a ser vista em `magnaleite.com`** — o browser continua a chamar `brainboxmed.com`. O próprio backend confirma este desenho: o CORS em `respond()` está configurado especificamente para aceitar pedidos com origem `https://magnaleite.com` dirigidos ao domínio `brainboxmed.com`.
- **Consequência:** os blocos de API do vhost `magnaleite` são, no estado atual do código, **código morto** — nunca são atingidos por nenhum pedido real. Isto também significa que, ao contrário do que uma leitura só do incidente do `about-photos` no logbook sugeriria, **não é preciso replicar cada novo endpoint nos dois vhosts** — só no `brainboxmed`, que é o único que a aplicação chama de facto. (O incidente do `about-photos` foi provavelmente causado por outra razão — nesse momento o `about-photos` pode ter sido chamado de forma relativa, antes do `BASE_URL` atual ser fixado; o importante é que, hoje, só o vhost `brainboxmed` importa para os endpoints de API.)
- Vale a pena, em algum momento, limpar os blocos de API mortos do vhost `magnaleite` (ou pelo menos corrigir o prefixo inconsistente e documentar que são vestigiais), para não confundir quem vier a mexer nisto sem saber deste detalhe — mas isso é cosmético, não urgente.

Depois de qualquer alteração ao Nginx:
```bash
nginx -t                 # valida a sintaxe antes de aplicar
systemctl reload nginx   # aplica sem cortar ligações já abertas
```

SSL é gerido pelo Certbot (Let's Encrypt). O vhost `magnaleite` já tem `listen 443 ssl` com certificado válido (`/etc/letsencrypt/live/magnaleite.com/`) — o problema de emissão registado no logbook de Junho 2026 (erro 503 do Let's Encrypt) **já está resolvido**, confirmado pela cópia real do vhost.

---

## 9. ⚠️ Inconsistências, riscos e pontos frágeis identificados

Esta secção foi pedida explicitamente: não assumir que "está em produção" = "está correto". Isto é uma leitura do código-fonte atual, não um pentest nem um teste em produção — trata os pontos marcados "verificar no servidor" como ação pendente, não como facto confirmado.

> **Legenda:** ✅ **Corrigido no código** (Setembro 2026) — ⚠️ **Corrigido, mas depende de ação no servidor** — 🔲 **Ainda por corrigir** (fora do pedido inicial, mantido para referência).

1. ⚠️ **Três endpoints usados pelo admin podiam não ter bloco Nginx — blocos já escritos, faltam aplicar no servidor.** O admin chama `POST /magna/api/save-collections`, `POST /magna/api/save-price-tiers`, `POST /magna/api/update-stripe-price` e agora também `GET /magna/api/verify-secret` (novo, ponto 3). A cópia de referência (`_local/nginx-brainboxmed.conf`) já foi atualizada com os quatro blocos em falta — mas **isto é só a cópia local**. Continua por fazer: editar `/etc/nginx/sites-available/brainboxmed` no servidor real, copiando os blocos novos, depois `nginx -t && systemctl reload nginx`. **Só neste vhost** — depois de obter e comparar a cópia real do vhost `magnaleite` (agora em `_local/nginx-magnaleite.conf`), confirmou-se que o domínio da API está sempre fixo em `brainboxmed.com` no código (ver secção 8), por isso o vhost `magnaleite` não precisa destes blocos novos. Enquanto o deploy no vhost `brainboxmed` não for feito, estes quatro endpoints continuam a devolver 404 em produção — o admin já vai mostrar esse erro claramente agora (ver pontos 2 e 5), mas as funcionalidades continuam indisponíveis até lá.

2. ✅ **`GET /magna/api/check-image` corrigido.** `save-artworks.js` agora tem um handler para este endpoint (valida `filename`/`type` e responde `{ exists }`). O aviso "já existe uma imagem com este nome, substituir?" no admin volta a funcionar como esperado. Precisa de deploy (`git pull` + `pm2 restart magna-api` no servidor) para entrar em produção — o bloco Nginx para `check-image` já existia antes, não precisa de alteração.

3. ✅ **Login do admin deixou de ser cosmético — agora valida o `MAGNA_API_SECRET` real contra o servidor.** Foi removido o hash SHA-256 fixo embutido no HTML. O ecrã de login pede diretamente o `MAGNA_API_SECRET` e chama o novo endpoint `GET /magna/api/verify-secret` para confirmar que é válido antes de desbloquear a interface — já não existe uma "password" separada e fictícia. Com "Guardar neste dispositivo" marcado, o secret fica em `localStorage` (persiste entre sessões, exatamente como pedido) e é revalidado a cada carregamento da página; se entretanto tiveres rodado o secret, deixa de desbloquear sozinho. Isto mantém exatamente a tua decisão: o `X-Magna-Secret` continua a ser o único ponto de confiança real do sistema — só deixou de haver uma segunda "fechadura" falsa ao lado dele. Precisa do novo endpoint `/verify-secret` a funcionar em produção (pontos 1 e 2) para o login funcionar.

4. ✅ **`MAGNA_API_SECRET` já não tem valor por omissão inseguro — o processo recusa-se a arrancar sem um secret forte.** `save-artworks.js` agora falha imediatamente (`process.exit(1)`, com mensagem clara no log do PM2) se `MAGNA_API_SECRET` não estiver definido, for o valor de exemplo `'CHANGE_THIS_SECRET'`, ou tiver menos de 16 caracteres. Já não é possível um deploy mal configurado ficar "a funcionar" com a chave pública. **Bónus de baixo custo incluído na mesma alteração:** a comparação do secret passou a usar `crypto.timingSafeEqual` (tempo constante), o que também resolve o antigo ponto 7 (vulnerabilidade teórica a ataques de temporização). Confirma no servidor, depois do deploy, que `ecosystem.config.js` tem um `MAGNA_API_SECRET` com pelo menos 16 caracteres — caso contrário o processo `magna-api` vai ficar parado (`pm2 status` mostrará `errored`/`stopped`) até corrigires.

5. ✅ **Falha silenciosa ao guardar `collections.json` corrigida — erros agora são sempre visíveis, com recuperação manual.** Em `saveToServer()`, um erro ao gravar `collections.json` deixou de ir só para `console.warn` — agora aparece na barra de estado, de forma persistente (não desaparece sozinho). Foi também acrescentado o botão **"🔄 Sincronizar Coleções"** no cabeçalho do admin, que recalcula `collections.json` a partir das obras carregadas e tenta gravar de novo — usa-o sempre que a barra de estado assinalar uma falha aqui, ou sempre que suspeitares de dessincronia (ex. depois de restaurar um backup). Isto não elimina a causa raiz (continuam a ser duas escritas separadas, sem transação única — ver ponto 1), mas resolve o problema real: deixares de saber que algo falhou.

6. ✅ **Sem cópia de segurança fora do droplet — resolvido com `_local/backup-offsite.sh`.** Foi criado um script (`_local/backup-offsite.sh`, não versionado — é código de infraestrutura do servidor, não do site) que empacota `artworks.json`, `collections.json`, `price-tiers.json`, `exhibitions.json` e a pasta `backups/` num `.tar.gz` datado e, se configurares `REMOTE_DEST` no topo do script, envia-o também para fora do droplet (via `rsync` ou `aws s3`). **Ainda por fazer, no servidor** (não é algo que dê para fazer a partir daqui): copiar o script para `/home/brainboxmed/magna/_local/backup-offsite.sh` via SCP, `chmod +x`, editar `REMOTE_DEST` com um destino real, testar manualmente uma vez, e agendar no `crontab` do utilizador `brainboxmed` (instruções completas dentro do próprio script). Sem este passo final no servidor, o script existe mas não corre sozinho.

7. 🔲 **Atualizações de preço no Stripe continuam sem ser atómicas nem ter rollback automático.** Não fazia parte do pedido de correção — mantido como estava. `swapPaymentLinkPrice()` cria o novo `Price`, troca-o no Payment Link, e só depois arquiva o `Price` antigo; uma falha a meio deixa um estado misto sem reversão automática. O `confirm()` no admin continua a avisar disto.

8. 🔲 **Não há limite de tentativas no `X-Magna-Secret`.** `checkAuth()` responde 403 e regista um aviso na consola, mas não há rate-limiting nem bloqueio depois de N tentativas falhadas — um atacante pode tentar valores à vontade contra qualquer endpoint de escrita. Vale a pena considerar um rate-limit básico (ex: `fail2ban` a observar o log do PM2, ou lógica simples no próprio Node).

9. ✅ **Cópia local do Nginx só tinha um vhost — resolvido, os dois estão agora documentados.** `_local/nginx-brainboxmed.conf` (capturada 24 Jul 2026, mais os blocos novos de Setembro) e agora também `_local/nginx-magnaleite.conf` (colada diretamente do servidor por Thiago em Setembro 2026). Comparar os dois revelou o achado do ponto 1/secção 8: o vhost `magnaleite` tem blocos de API com prefixo inconsistente (`/api/...` na maioria, `/magna/api/...` em dois deles) que nunca são atingidos por nenhum pedido real, porque o código chama sempre `brainboxmed.com`. Continua a valer a pena recapturar os dois vhosts periodicamente, sobretudo depois de qualquer alteração feita diretamente no servidor — a cópia local não se atualiza sozinha.

---

## 10. Checklist de segurança

Usa isto antes de considerares qualquer alteração "pronta para produção", e revê periodicamente (sugestão: a cada 3-6 meses, ou sempre que suspeitares de exposição):

- [ ] `ecosystem.config.js` (com os secrets reais) **nunca** aparece em `git status` como ficheiro rastreável — confirma com `git check-ignore -v ecosystem.config.js` no servidor.
- [ ] `MAGNA_API_SECRET` em produção tem pelo menos 16 caracteres e não é `'CHANGE_THIS_SECRET'` — desde a correção do ponto 4, o processo `magna-api` recusa-se a arrancar se isto não for verdade, por isso `pm2 status` a mostrar "online" já é, por si, uma confirmação. Se mostrar `errored`, confirma com `pm2 logs magna-api`.
- [ ] `MAGNA_API_SECRET`, `STRIPE_SECRET_KEY_LIVE` e `STRIPE_SECRET_KEY_TEST` são strings aleatórias fortes (ex. geradas com `openssl rand -hex 24`), não palavras/frases memorizáveis.
- [ ] As chaves do Stripe (live e test) nunca foram coladas em nenhum ficheiro que passe por Git, incluindo `magna-manager-x9z2-safe.html` — confirma com uma busca no histórico do repositório (`git log -p -- admin/magna-manager-x9z2-safe.html | grep -i "sk_live\|sk_test"`).
- [ ] O deploy destas correções foi feito no servidor: `git pull` em `/home/brainboxmed/magna`, depois `pm2 restart magna-api` — sem isto, `save-artworks.js` continua a correr a versão antiga (com o fallback de secret inseguro e sem `/verify-secret`/`/check-image`).
- [ ] `verify-secret`, `check-image`, `save-collections`, `save-price-tiers` e `update-stripe-price` têm blocos Nginx correspondentes nos **dois** vhosts (`brainboxmed` e `magnaleite`) — os quatro primeiros já estão escritos em `_local/nginx-brainboxmed.conf`, faltam aplicar no servidor (ver ponto 1 da secção 9). Sem isto, o login do admin não funciona (depende de `/verify-secret`).
- [ ] `nginx -t` sem erros depois de qualquer alteração à configuração, antes de fazer `reload`.
- [ ] Certificado SSL de `magnaleite.com` válido e a renovar automaticamente (`certbot certificates`) — havia um problema pendente registado em Junho 2026.
- [ ] Pasta `backups/` no servidor não está vazia e tem entradas recentes (`ls -lt backups/ | head`).
- [ ] `_local/backup-offsite.sh` foi instalado no servidor, testado manualmente, e agendado no `crontab` (ver ponto 6 da secção 9) — sem isto, continua sem existir cópia dos dados fora do droplet.
- [ ] Rotação de chaves: se alguma vez suspeitares que o `MAGNA_API_SECRET` ou uma chave Stripe foi exposta, rotaciona-a imediatamente:
  1. Gera um novo segredo/chave (`openssl rand -hex 24`, mínimo 16 caracteres — o backend recusa valores mais curtos).
  2. Atualiza `ecosystem.config.js` no servidor.
  3. `pm2 restart magna-api`.
  4. No Stripe dashboard, revoga a chave antiga (Developers → API keys).
  5. Da próxima vez que abrires `admin/magna-manager-x9z2-safe.html`, o secret antigo guardado localmente deixa de validar automaticamente (o `/verify-secret` vai falhar) e o login pede o novo — não precisas de tocar em nada no HTML. Podes também usar o botão "Sair" para forçar isso em qualquer dispositivo onde o secret antigo esteja guardado.

---

## 11. Apêndice — mapa de ficheiros e endpoints

### Ficheiros principais (frontend, vão por Git)

| Ficheiro | Função |
|---|---|
| `index.html` | Página principal — grelha de obras, filtros, QR da galeria no rodapé |
| `artwork.html` | Página de detalhe de uma obra (`?id=<slug>`) — preços, botões de compra, QR de proveniência |
| `qrcode.html` | Página A4 imprimível com o QR grande da galeria |
| `verify.html` / `verify-original.html` | Página de verificação de autenticidade (destino do QR de proveniência) |
| `exhibition.html` | Página de uma exposição |
| `digital-token.html`, `download-page.html`, `success-original.html` | Páginas do fluxo pós-compra (confirmação, download digital) |
| `admin/magna-manager-x9z2-safe.html` | Ferramenta de administração (obras, coleções, tiers, Stripe) |
| `admin/admin-hub.html` | Ponto de entrada para as várias ferramentas admin |
| `admin/certificate.html`, `admin/print-certificate.html` | Certificado de autenticidade de uma obra |
| `admin/magna-exhibitions-manager.html`, `admin/admin-labels.html`, `admin/exhibition-label.html`, `admin/admin-generator.html` | Ferramentas admin para exposições e etiquetas — fora do âmbito principal deste manual |
| `save-artworks.js` | Backend Node (todos os endpoints de escrita) |
| `package.json` | Só a dependência `stripe` |
| `ecosystem.config.example.js` | Template de configuração PM2 (sem secrets) |

### Ficheiros de dados (nunca vão por Git)

| Ficheiro | Formato | Escrito por |
|---|---|---|
| `artworks.json` | objeto `{ slug: {...} }` | `POST /save-artworks` |
| `collections.json` | objeto `{ id: { pt, en } }` | `POST /save-collections` |
| `price-tiers.json` | array `[{ label, original }]` | `POST /save-price-tiers` |
| `exhibitions.json` | objeto `{ slug: {...} }` | `POST /save-exhibitions` |
| `ecosystem.config.js` | JS (secrets reais) | criado manualmente uma vez, nunca reescrito por código |

### Endpoints do backend (`save-artworks.js`, porta 3100, só localhost)

| Endpoint | Método | Autenticado? | Bloco Nginx na cópia local (`_local/nginx-brainboxmed.conf`) | Aplicado no servidor real? |
|---|---|---|---|---|
| `/health` | GET | Não | — (não usado por nenhuma página) | — |
| `/verify-secret` | GET | Sim | ✅ Escrito (Set. 2026) | ❌ Por fazer — sem isto o login do admin não funciona |
| `/check-image` | GET | Sim | ✅ Já existia | ✅ (assumindo que já estava a funcionar antes) |
| `/save-artworks` | POST | Sim | ✅ Sim | ✅ |
| `/save-exhibitions` | POST | Sim | ✅ Sim | ✅ |
| `/save-collections` | POST | Sim | ✅ Escrito (Set. 2026) | ❌ Por fazer |
| `/save-price-tiers` | POST | Sim | ✅ Escrito (Set. 2026) | ❌ Por fazer |
| `/upload-painting-image` | POST | Sim | ✅ Sim | ✅ |
| `/upload-exhibition-flyer` | POST | Sim | ✅ Sim | ✅ |
| `/upload-exhibition-gallery` | POST | Sim | ✅ Sim | ✅ |
| `/about-photos` | GET | Não | ✅ Sim | ✅ |
| `/update-stripe-price` | POST | Sim | ✅ Escrito (Set. 2026) | ❌ Por fazer |

**Handler `/check-image` no código:** corrigido em Setembro 2026 — antes não existia (sempre 404), agora valida `filename`/`type` e responde `{ exists }`.

### Ficheiros de infraestrutura acrescentados (Setembro 2026, não versionados)

| Ficheiro | Função |
|---|---|
| `_local/backup-offsite.sh` | Script para copiar os JSON de dados + `backups/` para fora do droplet — precisa de ser instalado e agendado manualmente no servidor (ver ponto 6 da secção 9) |

---

*Manual gerado a partir da leitura direta do código-fonte do projeto (frontend, backend, configuração Nginx de referência e logbook técnico) em Setembro 2026. Sempre que este manual e o comportamento real do servidor em produção discordarem, o servidor é que manda — mas isso é também o sinal de que este documento precisa de ser atualizado.*
