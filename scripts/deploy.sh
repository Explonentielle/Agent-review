#!/usr/bin/env bash
# Déploiement de l'outil sur le VPS (variante « l'outil sur la machine », docs/deploiement.md section 11), à lancer dans la session `review`.
# Sauvegarde la base, met le code à jour (fast-forward seulement), refait ce que les fichiers changés exigent (dépendances, image des agents, unité
# systemd), compile, redémarre le service et attend `app.started`. Si le démarrage échoue, revient au commit précédent. Ne lit ni ne modifie jamais le .env.
# Usage : bash scripts/deploy.sh [--dry-run] [--force]
#   --dry-run : montre ce qui serait fait sans rien changer (seul un « git fetch » est lancé)
#   --force   : déploie même si un agent tourne (le redémarrage l'annule)
# Variables facultatives : AGENT_PACKAGES (paquets de l'image des agents), BACKUP_KEEP (sauvegardes gardées, défaut 30), START_TIMEOUT (secondes, défaut 60)
set -euo pipefail

cd "$(dirname "$0")/.."
UNIT="review-agent"
UNIT_FILE="deploy/review-agent.service"
UNIT_DIR="$HOME/.config/systemd/user"
START_TIMEOUT="${START_TIMEOUT:-60}"

# Même environnement que la session `review` (Docker sans root dans ~/bin) et que la sauvegarde de la variante « machine »
export PATH="$HOME/bin:$PATH"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.hote.yml}"
export BACKUP_KEEP="${BACKUP_KEEP:-30}"

dry=0
force=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --force) force=1 ;;
    *) echo "Option inconnue : $arg (voir l'en-tête du script)" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }

# Refait ce que les fichiers changés entre deux commits exigent. À appeler avec (état déployé, état voulu) : dans les deux sens pour un retour arrière.
refresh() {
  local from="$1" to="$2" files
  files="$(git diff --name-only "$from" "$to")"
  # Redirection plutôt que tube : avec pipefail, un grep -q qui quitte tôt ferait échouer le tube même si le motif est trouvé
  if grep -Eq '^package(-lock)?\.json$' <<<"$files"; then
    npm ci --no-audit --no-fund || return 1
  fi
  npx --no-install tsc -p tsconfig.build.json || return 1
  sync_unit "$from" "$to"
}

# Recopie l'unité systemd si elle a changé ET si l'installée est restée celle du dépôt (sinon la personne l'a adaptée : on prévient seulement)
sync_unit() {
  local from="$1" to="$2" installed="$UNIT_DIR/$UNIT.service"
  if git diff --quiet "$from" "$to" -- "$UNIT_FILE"; then return 0; fi
  if [ ! -f "$installed" ]; then
    echo "Unité installée introuvable ($installed) : non recopiée."
    return 0
  fi
  if cmp -s "$installed" <(git show "$to:$UNIT_FILE"); then return 0; fi
  if cmp -s "$installed" <(git show "$from:$UNIT_FILE"); then
    cp "$UNIT_FILE" "$installed"
    systemctl --user daemon-reload
    echo "Unité systemd recopiée et rechargée."
  else
    echo "ATTENTION : $UNIT_FILE a changé mais l'unité installée a été modifiée à la main : non recopiée. Compare : diff $installed $UNIT_FILE"
  fi
}

# Reconstruit l'image des agents (elle vit dans le Docker sans root de cet utilisateur)
build_image() {
  docker build -f Dockerfile.agent -t review-agent-sandbox:local \
    --build-arg AGENT_PACKAGES="${AGENT_PACKAGES:-php-cli php-mbstring php-xml unzip}" . || return 1
}

# Redémarre le service et attend `app.started` : code 0 si vu, 1 au bout de START_TIMEOUT secondes
restart_and_wait() {
  local since out waited=0
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl --user restart "$UNIT" || return 1
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    out="$(journalctl --user -u "$UNIT" --since "$since" --no-pager 2>/dev/null || true)"
    if grep -q 'app.started' <<<"$out"; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo "XDG_RUNTIME_DIR est vide : ouvre une vraie session (sudo machinectl shell review@), voir docs/deploiement.md étape 2." >&2
  exit 1
fi

# Un seul déploiement à la fois
exec 9>"$XDG_RUNTIME_DIR/review-agent-deploy.lock"
flock -n 9 || { echo "Un autre déploiement est en cours." >&2; exit 1; }

# Le dépôt du VPS ne doit contenir aucun changement local : un déploiement ne l'écrase pas
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Des fichiers suivis sont modifiés sur le VPS : rien n'est déployé (git status pour les voir)." >&2
  exit 1
fi
if ! git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  echo "La branche courante ne suit aucune branche distante : rien n'est déployé." >&2
  exit 1
fi

# Redémarrer annule les agents en cours : on refuse tant que l'un d'eux tourne
if ! docker info >/dev/null 2>&1; then
  echo "Docker sans root injoignable (DOCKER_HOST=$DOCKER_HOST) : rien n'est déployé." >&2
  exit 1
fi
agents="$(docker ps --format '{{.Names}}' | grep -c '^ra-agent-' || true)"
if [ "$agents" -gt 0 ] && [ "$force" != 1 ]; then
  if [ "$dry" = 1 ]; then
    echo "Note : $agents agent(s) en cours. Un vrai déploiement serait refusé tant qu'ils tournent (ou avec --force, qui les annule)."
  else
    echo "$agents agent(s) en cours (docker ps). Attends leur fin, ou relance avec --force : le redémarrage les annule." >&2
    exit 1
  fi
fi

old="$(git rev-parse HEAD)"
git fetch --quiet
new="$(git rev-parse '@{u}')"
if [ "$old" = "$new" ]; then
  echo "Déjà à jour ($(git rev-parse --short HEAD)). Rien à déployer."
  exit 0
fi
if ! git merge-base --is-ancestor "$old" "$new"; then
  echo "Le VPS a des commits que la branche distante n'a pas : pas de fast-forward possible, rien n'est déployé." >&2
  exit 1
fi

changed="$(git diff --name-only "$old" "$new")"
touches() { grep -Eq "$1" <<<"$changed"; }
need_npm=0
need_image=0
if touches '^package(-lock)?\.json$'; then need_npm=1; fi
if touches '^Dockerfile\.agent$'; then need_image=1; fi

say "Mise à jour $(git rev-parse --short "$old") -> $(git rev-parse --short "$new")"
git log --oneline "$old..$new"
git diff --stat "$old" "$new" | tail -n 25

if [ "$dry" = 1 ]; then
  say "Simulation (--dry-run) : rien n'a été changé. Étapes prévues"
  echo "  1. sauvegarde de la base (scripts/backup.sh)"
  echo "  2. git merge --ff-only"
  if [ "$need_npm" = 1 ]; then echo "  3. npm ci (package.json ou verrou changé)"; fi
  if [ "$need_image" = 1 ]; then echo "  3. reconstruction de l'image des agents (Dockerfile.agent changé)"; fi
  if touches "^$UNIT_FILE\$"; then echo "  3. unité systemd : recopie si l'installée est restée celle du dépôt"; fi
  echo "  4. compilation (tsc), redémarrage du service, attente de app.started (${START_TIMEOUT} s au plus)"
  echo "  5. retour au commit précédent si le service ne démarre pas"
  exit 0
fi

say "Sauvegarde de la base"
bash scripts/backup.sh

say "Mise à jour du code"
git merge --ff-only --quiet "$new"

say "Dépendances, compilation, image"
prepare() {
  refresh "$old" "$new" || return 1
  if [ "$need_image" = 1 ]; then build_image || return 1; fi
}
if ! prepare; then
  echo "La préparation a échoué : retour au commit $(git rev-parse --short "$old"). Le service n'a pas été redémarré." >&2
  git reset --hard --quiet "$old"
  refresh "$new" "$old" || echo "ATTENTION : la recompilation de l'ancien commit a échoué aussi, vérifie dist/ avant tout redémarrage." >&2
  exit 1
fi

say "Redémarrage"
if ! restart_and_wait; then
  echo "Le service n'a pas affiché app.started en ${START_TIMEOUT} s. Fin du journal :" >&2
  journalctl --user -u "$UNIT" -n 30 --no-pager >&2 || true
  echo "Retour au commit $(git rev-parse --short "$old")..." >&2
  git reset --hard --quiet "$old"
  refresh "$new" "$old" || echo "ATTENTION : la recompilation de l'ancien commit a échoué." >&2
  if restart_and_wait; then
    echo "Retour arrière réussi : le service tourne sur l'ancien commit. Une migration déjà jouée n'est pas défaite : la sauvegarde est dans backups/." >&2
  else
    echo "Le service ne démarre pas non plus sur l'ancien commit : journalctl --user -u $UNIT -n 50. La sauvegarde est dans backups/." >&2
  fi
  exit 1
fi

say "Terminé : $(git rev-parse --short "$old") -> $(git rev-parse --short "$new"), service démarré"
if touches '^src/db/migrations\.ts$'; then echo "Rappel : une migration de base a été appliquée au démarrage (un retour arrière du code ne la défait pas)."; fi
if touches '^src/config\.ts$'; then echo "Rappel : src/config.ts a changé : une variable est peut-être à ajouter dans le .env (à la main). Voir : git diff $old $new -- src/config.ts"; fi
if [ "$need_image" = 1 ]; then echo "Rappel : l'image des agents a été reconstruite (Paramètres > Agents dans des conteneurs > Tester les conteneurs)."; fi
