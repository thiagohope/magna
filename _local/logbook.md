# Magna Leite — Project Logbook
**Gestor técnico:** Thiago  
**Última actualização:** Junho 2026

---

## Estado actual do projecto

- Site live em `magnaleite.com` (também acessível via `brainboxmed.com/magna`)
- Stack: HTML/CSS/JS estático + Node.js API (`magna-api`, porta 3100) + PM2 + Nginx + DigitalOcean
- Dados: `artworks.json` e `exhibitions.json` (via SCP/WinSCP), código via Git
- Pagamentos: Stripe (test + live)
- SSL: Let's Encrypt / Certbot (pendente renovação para `magnaleite.com`)

---

## Decisões técnicas registadas

### Arquitectura de dados
- `artworks.json` está no `.gitignore` — viaja sempre via WinSCP, nunca pelo Git
- `ecosystem.config.js` nunca commitado — só `ecosystem.config.example.js` é tracked
- Campo `image` em `artworks.json` suporta string (obra simples) ou array (dípticos/séries)
- Campo `thumbnail` aponta sempre para `assets/paintings/thumbnails/`

### Hero do index
- Foto de fundo: `magna02.jpeg` (Magna ao lado de obra)
- Mobile: `object-fit: contain` (foto inteira visível)
- Desktop: `object-fit: cover` (preenche sem barras)
- Card flutuante com `margin-top` negativo para efeito de elevação

### Tipografia
- Fonte escolhida: **Plus Jakarta Sans** (títulos + corpo) — mais próxima do Graphik usado pelo Saatchi Art
- Fallback editorial: Playfair Display (lightbox, títulos de obras)
- EB Garamond disponível mas não activo

### Grelha de obras
- CSS Grid puro — 2 colunas até 1024px, 3 colunas acima
- Imagens sem moldura (`border` e `border-radius` removidos)
- `width: 100%; height: auto` — proporção natural preservada
- `max-height: 75vh` no `zoom-img` do `artwork.html` para portraits não cortarem em tablet

### Suporte a dípticos (Mosaico)
- `art.image` pode ser array: `["full/img1.jpg", "full/img2.jpg", "full/diptico.jpg"]`
- `artwork.html` detecta array automaticamente e mostra navegação com thumbnails
- Todos os ficheiros admin corrigidos para usar `Array.isArray(art.image) ? art.image[0] : art.image`
- Thumbnail na grelha do index usa sempre o campo `thumbnail` (díptico completo)

---

## Projectos futuros

### 🔲 AR — "Ver na minha parede"
**Prioridade:** Média  
**Complexidade:** Média-alta  
**Descrição:** Ferramenta de Augmented Reality semelhante à do Saatchi Art. O visitante aponta a câmara do telemóvel para uma parede e vê a obra em escala real (baseada nas dimensões reais do `artworks.json`).  
**Abordagem técnica prevista:**
- Android (Chrome): WebXR API
- iOS (Safari): AR Quick Look com USDZ
- Botão "Ver na minha parede" no `artwork.html`
- Sem app nativa — 100% web  
**Dependências:** Conversão de imagem 2D para formato AR (USDZ para iOS)

---

### 🔲 Múltiplas fotos por obra + cenário de sala
**Prioridade:** Média  
**Complexidade:** Média  
**Descrição:** Para além da foto da obra isolada, possibilidade de incluir:
1. Fotos adicionais da obra (detalhes, ângulos, obra assinada)
2. Foto da obra num cenário de sala padrão criado especificamente para simular o ambiente real de exposição
**Abordagem técnica prevista:**
- Extensão do array `image` já implementado para dípticos
- Criar 1–2 cenários de sala standard (fotografia ou render 3D com a obra inserida)
- Navegação entre fotos já existe no `artwork.html` — só precisaria de ser activada  
**Dependências:** Criação dos cenários de sala (fotografia/design)

---

### 🔲 SSL para magnaleite.com
**Prioridade:** Alta  
**Descrição:** Certbot falhou numa sessão anterior por erro 503 do Let's Encrypt. Retry pendente.  
**Comando:**
```bash
certbot --nginx -d magnaleite.com -d www.magnaleite.com
```

---

### 🔲 Reconciliação Stripe ↔ artworks.json
**Prioridade:** Média  
**Descrição:** Verificar se os preços no Stripe (live) estão alinhados com os `priceDisplay` no `artworks.json`.

---

### 🔲 App mobile (Android) para admin no terreno
**Prioridade:** Baixa  
**Descrição:** Uso do Samsung Galaxy Tab S10 Lite para tarefas de admin em exposições (fotografar, actualizar estado de obras, imprimir etiquetas).

---

## Obras no catálogo

| Slug | Título | Status |
|------|--------|--------|
| `mertola` | Mértola | Disponível |
| `tempo` | Tempo | Disponível |
| `rainha` | A Rainha | Disponível |
| `figueirinha` | A Figueirinha | Disponível |
| `trabalho` | O Futuro do Trabalho | Disponível |
| `choco` | Choco | Disponível |
| `mosaico` | Mosaico (díptico) | Disponível |

---

*Logbook mantido por Thiago · Brainboxmed Project*
