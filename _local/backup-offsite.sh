#!/usr/bin/env bash
#
# backup-offsite.sh — Magna Art: cópia dos dados fora do droplet
# ============================================================
# PORQUÊ ESTE SCRIPT EXISTE
# artworks.json, collections.json, price-tiers.json e exhibitions.json
# nunca vão por Git (de propósito — ver manual técnico, secção 7). O único
# histórico automático que existe é a pasta backups/, gerada pelo próprio
# save-artworks.js, mas ela vive DENTRO do mesmo droplet que serve o site.
# Se o disco falhar, ou alguém apagar backups/ por engano, perde-se tudo
# exceto o que tiver sido exportado manualmente para outro sítio.
#
# Este script faz um tar.gz datado dos dados + backups e, se REMOTE_DEST
# estiver configurado, envia-o também para fora do droplet via rsync/scp.
#
# INSTALAÇÃO (no servidor brainboxmed-server-01, não daqui):
#   1. scp este ficheiro para o servidor, ex.:
#        /home/brainboxmed/magna/_local/backup-offsite.sh
#   2. chmod +x backup-offsite.sh
#   3. Edita REMOTE_DEST abaixo (ou deixa vazio para só gerar o tar.gz local)
#   4. Testa manualmente uma vez:  ./backup-offsite.sh
#   5. Agenda no cron do utilizador brainboxmed, ex. todos os dias às 04:00:
#        crontab -e
#        0 4 * * * /home/brainboxmed/magna/_local/backup-offsite.sh >> /home/brainboxmed/magna/_local/backup-offsite.log 2>&1
#
# Este script NÃO é executado automaticamente por nada neste projeto —
# precisa de ser instalado e agendado manualmente no servidor.

set -euo pipefail

PROJECT_DIR="/home/brainboxmed/magna"
ARCHIVE_DIR="${PROJECT_DIR}/_local/offsite-archives"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
ARCHIVE_NAME="magna-data-backup-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${ARCHIVE_DIR}/${ARCHIVE_NAME}"

# Destino fora do droplet — deixa em branco para só gerar o tar.gz local.
# Exemplos:
#   REMOTE_DEST="user@outro-servidor:/backups/magna/"
#   REMOTE_DEST="s3://o-teu-bucket/magna-backups/"   (precisa de aws-cli configurado)
REMOTE_DEST=""

mkdir -p "${ARCHIVE_DIR}"

tar -czf "${ARCHIVE_PATH}" \
    -C "${PROJECT_DIR}" \
    artworks.json collections.json price-tiers.json exhibitions.json backups/

echo "[$(date -u +%FT%TZ)] Arquivo criado: ${ARCHIVE_PATH} ($(du -h "${ARCHIVE_PATH}" | cut -f1))"

if [ -n "${REMOTE_DEST}" ]; then
    if [[ "${REMOTE_DEST}" == s3://* ]]; then
        aws s3 cp "${ARCHIVE_PATH}" "${REMOTE_DEST}"
    else
        rsync -avz "${ARCHIVE_PATH}" "${REMOTE_DEST}"
    fi
    echo "[$(date -u +%FT%TZ)] Enviado para ${REMOTE_DEST}"
else
    echo "[$(date -u +%FT%TZ)] REMOTE_DEST vazio — arquivo ficou só em ${ARCHIVE_DIR} (ainda dentro do droplet)."
fi

# Mantém só os 30 arquivos mais recentes localmente (evita encher o disco).
find "${ARCHIVE_DIR}" -name 'magna-data-backup-*.tar.gz' -type f -printf '%T@ %p\n' \
    | sort -rn | tail -n +31 | cut -d' ' -f2- | xargs -r rm -f
