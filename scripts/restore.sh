#!/usr/bin/env bash
# Restauration de la base PostgreSQL du déploiement Docker depuis une sauvegarde de scripts/backup.sh.
# DESTRUCTIF : la base actuelle est supprimée puis recréée à partir du fichier. À essayer d'abord sur une copie (voir docs/deploiement.md).
# Usage : bash scripts/restore.sh <fichier.sql.gz> --yes
set -euo pipefail

cd "$(dirname "$0")/.."
file="${1:-}"
confirm="${2:-}"

if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Usage : bash scripts/restore.sh <fichier.sql.gz> --yes" >&2
  exit 2
fi
if [ "$confirm" != "--yes" ]; then
  echo "Cette commande supprime la base actuelle. Relance-la avec --yes pour confirmer." >&2
  exit 2
fi
gzip -t "$file"

echo "Arrêt de l'application (la base reste démarrée)..."
docker compose stop app

echo "Recréation de la base..."
docker compose exec -T postgres psql -U review -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS review_agent WITH (FORCE)" \
  -c "CREATE DATABASE review_agent OWNER review"

echo "Chargement de la sauvegarde..."
gzip -dc "$file" | docker compose exec -T postgres psql -U review -d review_agent -v ON_ERROR_STOP=1 --quiet

echo "Redémarrage de l'application..."
docker compose start app
echo "Restauration terminée."
