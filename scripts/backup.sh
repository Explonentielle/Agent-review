#!/usr/bin/env bash
# Sauvegarde de la base PostgreSQL du déploiement Docker (voir docs/deploiement.md).
# La clé maître des secrets (SECRETS_MASTER_KEY) n'est JAMAIS dans cette sauvegarde : sans elle, les jetons enregistrés restent illisibles.
# Sauvegarde-la ailleurs, séparément.
# Usage : bash scripts/backup.sh        (dossier : BACKUP_DIR, défaut ./backups ; nombre gardé : BACKUP_KEEP, défaut 14)
set -euo pipefail

cd "$(dirname "$0")/.."
dest="${BACKUP_DIR:-./backups}"
keep="${BACKUP_KEEP:-14}"

mkdir -p "$dest"
umask 077 # lisible par son propriétaire seul : la base contient des données de tickets et de code
file="$dest/review_agent_$(date +%Y-%m-%d_%H%M%S).sql.gz"

docker compose exec -T postgres pg_dump -U review -d review_agent --no-owner | gzip > "$file"

# Une sauvegarde vide ou illisible est pire que pas de sauvegarde : on la refuse
if [ ! -s "$file" ] || ! gzip -t "$file"; then
  echo "Sauvegarde invalide, supprimée : $file" >&2
  rm -f -- "$file"
  exit 1
fi

# Ne garde que les plus récentes
ls -1t "$dest"/review_agent_*.sql.gz | tail -n +"$((keep + 1))" | xargs -r rm --

echo "Sauvegarde écrite : $file ($(du -h "$file" | cut -f1))"
