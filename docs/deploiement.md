# Déploiement sur le VPS (pilote)

Statut au 2026-11-10 : **préparé, jamais construit ni lancé** (aucune image n'a été construite, aucun conteneur démarré : cela demande de télécharger des paquets, ce qui n'a pas été fait). La syntaxe du fichier compose, des scripts et la compilation de production (`tsc -p tsconfig.build.json`, 68 modules chargés sans erreur) sont vérifiées. Le premier `docker compose build` peut révéler des erreurs : note-les, elles se corrigent vite.

Fichiers : `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `tsconfig.build.json`, `scripts/backup.sh`, `scripts/restore.sh`. Variante avec les agents en conteneurs (décidée le 2026-11-12, préparée, jamais essayée sur le VPS) : `Dockerfile.agent`, `docker-compose.hote.yml`, `deploy/review-agent.service`, voir la section 11.

## 1. Ce que ça installe

- **app** : l'outil (Node 24, CLI Claude Code, git), utilisateur sans droits, système de fichiers en lecture seule sauf le volume de données et `/tmp`, aucune capacité Linux, 2,5 Go de mémoire et 2 processeurs au plus. Port publié **sur la boucle locale seulement** (`127.0.0.1:4321`).
- **postgres** : PostgreSQL 16, aucun port publié, sur un réseau sans accès à Internet. Seule l'application le joint.
- Deux volumes : `appdata` (copies de dépôts, dossiers de travail des agents, journaux, configuration de la CLI) et `pgdata` (la base).

## 2. Cohabitation avec rag-saas

Le VPS (4 vCores, 8 Go, Ubuntu 26.04) héberge déjà rag-saas en production (Caddy sur 80, 443 et 8443, Elasticsearch ~1,9 Go, un service d'OCR). Il reste environ 5 Go disponibles, sans swap. Les plafonds du fichier compose (2,5 Go pour l'application, 0,5 Go pour la base) laissent environ 2 Go de marge : **ne les augmente pas sans regarder `free -h`**. Un seul agent à la fois (`MAX_CONCURRENT_AGENTS=1`, valeur par défaut). L'outil n'utilise aucun des ports de rag-saas.

## 3. Préparer le serveur (une fois)

1. **Swap de 2 Go**, pour absorber un pic sans que le noyau tue Elasticsearch ou rag-saas :
   ```
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
   `fallocate` réserve le fichier, `chmod 600` le rend illisible aux autres, `mkswap` le formate en swap, `swapon` l'active, et la dernière ligne l'active aussi après un redémarrage.
2. **Un utilisateur Linux dédié** (`review`), sans sudo, qui possède le dossier du projet. Pour lancer Docker il doit être dans le groupe `docker`, ce qui équivaut à un accès root à la machine : ne l'utilise pas pour autre chose. (Avec la variante de la section 11, Docker sans root, il n'a **pas** besoin de ce groupe : ne l'y mets pas.)
3. **Ne rien ouvrir dans le pare-feu.** L'accès se fait par tunnel SSH (section 6). Après le démarrage, `ss -tlnp | grep 4321` doit montrer `127.0.0.1:4321` et rien d'autre.

## 4. Configurer

Dans le dossier du projet sur le serveur, crée le fichier `.env` (`chmod 600 .env`), à partir de `.env.example`. **Je n'y touche pas : tu le remplis toi-même.** Variables propres à ce déploiement :

| Variable | Rôle | Comment l'obtenir |
|---|---|---|
| `POSTGRES_PASSWORD` | mot de passe de la base (obligatoire) | `openssl rand -base64 24` |
| `SECRETS_MASTER_KEY` | clé qui chiffre les jetons enregistrés (obligatoire en mode serveur) | `openssl rand -base64 32` |
| `PUBLIC_URL` | adresse que voit ton navigateur | `http://localhost:4321` avec le tunnel |
| `AUTH_*` | connexion par compte de forge (fortement recommandée) | voir `.env.example` et `docs/a-tester.md`, section 5 |
| `GITLAB_URL` et/ou `GITHUB_TOKEN` | forges du propriétaire | comme en local |

`openssl rand -base64 N` tire N octets au hasard et les écrit en base64. **Sauvegarde `SECRETS_MASTER_KEY` à part** (gestionnaire de mots de passe) : sans elle les jetons enregistrés sont perdus, et elle ne doit jamais être dans la même archive que les sauvegardes de la base.

### Droits des jetons, et le Scribe

Les jetons se saisissent dans la forge (fourneau GitHub ou GitLab) ou dans Paramètres > Connexion. Deux niveaux de droits :

| | Agents seuls (le minimum) | Avec le Scribe (créer tickets et projets) |
|---|---|---|
| GitLab | scopes `api`, `read_repository`, `write_repository` ; rôle Developer dans les projets où l'agent code | même jeton. Tickets : rôle Reporter au moins dans le projet. Projets : dans le groupe visé, un rôle qui autorise la création de projets (Developer, Maintainer ou Owner selon les réglages du groupe) ; sans groupe, le projet va dans ton espace personnel |
| GitHub (portée fine) | Contents, Pull requests, Issues en lecture et écriture ; Checks et Commit statuses en lecture | Tickets : rien de plus. Dépôts : « Administration » ou « Repository creation » en lecture et écriture, avec pour « Resource owner » ton compte ou l'organisation visée |
| GitHub (classique) | scope `repo` | scope `repo` |

Le Scribe vérifie ces droits à l'usage : un refus de la forge devient un message qui dit quel droit ajouter. Chaque ticket ou projet créé est tracé au journal d'audit (jamais le texte du ticket). Plafonds par personne et par heure : 30 brouillons, 40 tickets, 5 projets.

## 5. Lancer

```
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```
`build` construit l'image (plusieurs minutes la première fois), `up -d` démarre la pile en arrière-plan, `ps` doit montrer `app` et `postgres` en bonne santé (`healthy`), `logs -f` suit le journal ; on y lit `app.started`. Les migrations de la base s'appliquent toutes seules au démarrage. Pour figer la version de la CLI Claude Code : `CLAUDE_CODE_VERSION=<version> docker compose build`.

## 5 bis. Importer ta base locale (facultatif, une seule fois)

Pour retrouver sur le serveur tes reviews, tâches, projets, réglages et jetons enregistrés. À faire **avant** de configurer quoi que ce soit sur le serveur : la base du serveur doit être vide (l'import refuse sinon, sans rien effacer).

1. Arrête l'outil local (Ctrl+C dans le terminal de `npm run dev`) pour que le fichier soit complet, puis copie `~/review-agent/data/review-agent.sqlite` sur le serveur (`scp`).
2. **Clé maître** : les jetons enregistrés sont chiffrés avec la clé de ton fichier `data/master.key`. Pour qu'ils restent lisibles sur le serveur, mets le contenu de ce fichier (une ligne) dans `SECRETS_MASTER_KEY` du `.env` du serveur. Avec une autre clé, l'import marche mais les jetons sont ignorés au démarrage (tu les ressaisis dans le dashboard).
3. Sur le serveur, base démarrée mais application arrêtée :
   ```
   docker compose stop app
   docker compose run --rm -v "$PWD/review-agent.sqlite:/app/data/import.sqlite:ro" app node dist/cli/importSqlite.js /app/data/import.sqlite
   docker compose up -d app
   ```
   `stop` coupe l'application, `run --rm` lance l'outil d'import dans un conteneur jetable (démarrant la base au besoin), `-v ...:ro` y monte ton fichier en lecture seule (l'import travaille sur une copie), `up -d` redémarre l'application.
4. L'import affiche le nombre de lignes copiées par table et vérifie qu'il n'en manque aucune. Tout est fait dans une transaction : en cas d'erreur, la base du serveur reste intacte. Les identifiants sont conservés. Les chemins de dossiers de travail locaux des tâches de dev sont vidés (ils n'existent pas sur le serveur) ; les sessions de connexion ne suivent pas.

## 6. Y accéder

Depuis ton poste, un tunnel SSH vers le serveur :
```
ssh -N -L 4321:127.0.0.1:4321 review@<adresse-du-vps>
```
`-N` n'ouvre pas de shell, `-L 4321:127.0.0.1:4321` relie le port 4321 de ton poste au port 4321 de la boucle locale du serveur. Laisse la fenêtre ouverte et ouvre http://localhost:4321. Il n'y a pas de TLS : le tunnel SSH chiffre le trajet. Un nom de domaine et un certificat ne sont nécessaires que pour ouvrir à d'autres personnes sans tunnel, et **pas avant** que les conteneurs d'agents (lot D) existent.

## 6 bis. Connecter ton abonnement Claude depuis le navigateur

Les agents utilisent la CLI Claude Code du conteneur, connectée une fois à ton abonnement. Sans SSH : **Paramètres > Connexion > Abonnement Claude > Ouvrir le terminal Claude**.

1. Le terminal ouvre la CLI. Choisis la connexion avec ton compte Claude (abonnement), ouvre le lien affiché dans ton navigateur, connecte-toi, puis colle le code qu'il te donne dans le terminal (Ctrl+Maj+V ou clic droit). Si rien ne la propose, tape `/login`.
2. La pastille passe à « connecté » toute seule (contrôle toutes les 8 s tant que le terminal est ouvert). Elle vient de `claude auth status` : tu peux aussi cliquer sur « Vérifier la connexion ».
3. La session est enregistrée dans le volume de données (`/app/data/home`), elle survit aux redémarrages et aux mises à jour, pas à `docker compose down -v`.

Ce que le terminal est, et n'est pas :
- **La CLI `claude` seule**, jamais un shell : le conteneur contient dans son environnement le mot de passe de la base et la clé maître, un shell les montrerait. La CLI reçoit l'environnement filtré des agents.
- **Une session à la fois**, fermée après 15 min sans saisie ou 1 h au plus. Taille fixe (100 colonnes sur 30 lignes) : l'outil `script` ne transmet pas les changements de taille.
- **Réservé au propriétaire de l'installation.** Sans connexion par compte (`AUTH_*`), il est aussi **refusé dès que la requête passe par un reverse proxy** (en-têtes `X-Forwarded-*`) : il ne doit jamais être ouvert à Internet sans authentification. Le tunnel SSH de la section 6 n'ajoute aucun de ces en-têtes.
- **Linux seulement** : il s'appuie sur l'outil `script` (paquet `bsdutils`, présent dans l'image Debian de l'outil ; vérifier avec `docker compose exec app which script`). Ailleurs, l'écran l'explique et le terminal est indisponible.
- Si le terminal échoue, le repli est `docker compose exec -it app claude` en SSH, puis `/login`.

## 7. Sauvegardes

- `bash scripts/backup.sh` écrit `backups/review_agent_<date>.sql.gz` (lisible par son propriétaire seul), vérifie qu'elle n'est pas vide, garde les 14 dernières. Exemple de planification quotidienne : `crontab -e` puis `30 3 * * * cd /chemin/du/projet && bash scripts/backup.sh >> backups/backup.log 2>&1`.
- **Copie hors du serveur** : une sauvegarde sur le disque qui tombe en panne ne sert à rien. Récupère le dossier `backups/` régulièrement (`scp`, `rsync`).
- **Restauration** : `bash scripts/restore.sh backups/<fichier>.sql.gz --yes` arrête l'application, supprime la base, la recrée depuis le fichier et redémarre. C'est destructif : **essaie-la une fois avant d'en avoir besoin**, par exemple sur ton poste avec un second projet compose (`docker compose -p essai ...`).
- Le volume `appdata` (copies de dépôts, dossiers de travail) n'est pas sauvegardé : il se reconstitue. On perd seulement la reprise d'une session d'agent en cours.

## 8. Mettre à jour, revenir en arrière

```
bash scripts/backup.sh
git pull
docker compose build
docker compose up -d
```
Sauvegarde d'abord : les migrations de base ne se défont pas. Retour arrière : revenir au commit précédent (`git checkout <commit>`), reconstruire, et si une migration était passée, restaurer la sauvegarde d'avant.

## 9. Limites connues, à lire

- **L'import de ta base locale (SQLite) est possible une seule fois**, dans une base vide (section 5 bis). Il n'existe pas de synchronisation continue entre ta machine et le serveur : ce sont deux installations séparées.
- **Tous les agents tournent dans le même conteneur**, avec le même utilisateur système que l'application. Les secrets du `.env` sont retirés de l'environnement des agents (jetons, clé maître, adresse de la base, secrets OAuth) : une commande qui affiche son environnement ne les voit pas. **Ce n'est pas une isolation** : un processus du même utilisateur peut lire l'environnement de son processus parent (`/proc`) et les fichiers du volume de données, dont les copies de dépôts des autres personnes. Tant que les conteneurs par personne (lot D) n'existent pas : **personnes de confiance seulement**.
- Pas de limite de mémoire par agent (seulement celle du conteneur entier) ni d'isolation réseau des agents.
- Les journaux sont dans le volume (`/app/data/logs`), sans rotation. À surveiller si le disque se remplit.
- Rien n'a été essayé sur le vrai VPS : coexistence avec rag-saas, mémoire réelle, durée du build.

## 10. Agents dans des conteneurs (lot D, première tranche)

`AGENT_RUNTIME=docker` (variables `AGENT_*` du `.env.example`) fait tourner chaque review et chaque tâche de dev dans un **conteneur jetable** créé pour la tâche et supprimé ensuite. Le conteneur : système de fichiers en lecture seule (sauf `/tmp` et le dossier personnel de l'agent, en mémoire), aucune capacité Linux, pas d'élévation de droits, mémoire, processeurs et processus plafonnés, utilisateur sans droits. Il ne monte **que** le dossier de travail de la tâche. Il ne reçoit ni la base, ni la clé maître, ni les jetons de forge, ni les dossiers des autres personnes, ni l'environnement de l'outil : seulement la clé API Anthropic de la personne. Vérifié avec le vrai Docker sur une image locale (utilisateur 1000, racine en lecture seule, capacités à zéro, `no_new_privs`, jeton de forge absent).

**Ce que ça exige**
- Le **mode clé API** (Paramètres > Modèles) : l'abonnement vit dans ton dossier personnel, qu'on ne monte pas dans un conteneur. Avec `AGENT_RUNTIME=docker` et le mode abonnement, l'outil **refuse** de lancer l'agent plutôt que de retomber sur la machine.
- Une **image** qui contient la CLI Claude Code (`claude`) **et** les outils des projets, construite avec `Dockerfile.agent` (Node, git, la CLI) : `docker build -f Dockerfile.agent -t review-agent-sandbox:local .` (nom par défaut de `AGENT_IMAGE`). Les outils de tes projets s'ajoutent avec `--build-arg AGENT_PACKAGES="php-cli php-mbstring php-xml unzip"`. Ce sont les paquets de Debian bookworm (PHP 8.2 par exemple) : un projet qui exige une autre version (PHP 7.3...) a besoin de sa propre image (voir « Une image par projet » plus bas). L'image n'est jamais téléchargée au lancement d'une tâche (`--pull never`).
- L'outil doit pouvoir lancer `docker`.

**Vérifier que tout est prêt** : dans le dashboard, Paramètres > **Agents dans des conteneurs** > **Tester les conteneurs**. L'outil lance un conteneur d'essai avec les options exactes d'une vraie tâche et affiche sept contrôles : mode clé API, Docker (version, avec ou sans root), image présente, écriture dans le dossier de travail, isolation (système de fichiers en lecture seule, capacités retirées, pas d'élévation de droits), plafonds de mémoire et de processus réellement appliqués, CLI Claude Code présente. Chaque échec dit quoi faire. Le test dure quelques secondes, ne touche à aucun réglage, et supprime son conteneur et son dossier d'essai ensuite.

**Une image par projet** : tes projets n'ont pas tous les mêmes outils (PHP 7.1, 7.3, 8.2...). Construis une image par pile (la CLI Claude Code, qui demande Node, plus les outils du projet ; `Dockerfile.agent` sert de modèle), ajoute leurs noms à `AGENT_IMAGES` dans le `.env` (séparés par des virgules), redémarre l'outil, puis choisis l'image du projet dans Paramètres > Projets > Modifier > Image de l'agent. Sans choix, c'est `AGENT_IMAGE`. Seules les images de `AGENT_IMAGE` et `AGENT_IMAGES` sont permises : le `.env` reste seul maître de la liste, sinon un réglage de projet pourrait lancer n'importe quelle image présente sur la machine. Une image non autorisée est refusée à l'enregistrement du projet et, par sécurité, au lancement de chaque tâche (elle échoue avec la raison). Le bouton « Tester » de la section des conteneurs essaie chaque image séparément.
- Dans un conteneur il n'y a pas de Docker : les « Commandes autorisées » du projet doivent appeler directement les outils de l'image (`vendor/bin/phpunit`), et non `docker run ... php:7.3-cli vendor/bin/phpunit` comme en mode machine. `{worktree}` ne sert pas dans ce mode.
- Les paquets de Debian bookworm n'incluent pas PHP 7.3 : pour un projet en PHP 7.3 ou plus ancien, il faut partir d'une image du projet (par exemple `php:7.3-cli`) et y installer Node et la CLI Claude Code. Non essayé ici.

**Décision de déploiement (2026-11-12) : l'outil sur la machine, avec Docker sans root**
Lancer des conteneurs, c'est pouvoir être root sur la machine : le processus qui lance `docker` est de confiance. L'application dans son conteneur (le `docker-compose.yml` des sections 1 à 8) n'a **pas** accès à Docker et ne peut donc pas utiliser ce mode. Deux voies existaient, la première est **retenue** :
1. L'outil tourne sur la machine sous un utilisateur dédié avec **Docker sans root** (rootless) ; seule la base reste dans compose. Une compromission de l'outil ne donne alors pas root. Mise en place à la section 11.
2. L'application reste dans son conteneur avec le socket Docker monté : plus simple, mais le conteneur de l'application devient équivalent à root sur la machine. Un proxy de socket n'y change rien (il ne peut pas filtrer les dossiers montés). **Écartée.**
Tant que la section 11 n'est pas appliquée, les agents du déploiement Docker des sections 1 à 8 tournent comme avant (dans le conteneur de l'application, avec la limite expliquée plus haut).

**Limites**
- La clé API de la personne est visible de son propre agent (il en a besoin) : sans filtre du réseau sortant (D7), un agent manipulé pourrait l'envoyer ailleurs. Une clé par personne avec un budget limité chez Anthropic réduit ce risque.
- Le dossier de travail est un `git worktree` : son dépôt est ailleurs sur la machine, donc les commandes `git` de l'agent dans le conteneur échouent (lire, chercher et modifier des fichiers marchent ; l'outil fait lui-même les commits et le push).
- Le réseau est celui par défaut de Docker (accès à Internet). Pas encore de liste blanche (D7), ni de terminal (D8), ni de modèles d'environnement partagés (D9).
- La reprise d'une session d'agent (« Reprendre la main ») n'existe pas en mode conteneur : sa session ne survit pas à la tâche.

## 11. Variante avec les agents en conteneurs : l'outil sur la machine, Docker sans root

**Statut : préparée, jamais essayée sur le VPS.** Le code est testé avec un faux `docker` ; le fichier compose et l'unité systemd sont vérifiés par leurs outils (`docker compose config`, `systemd-analyze verify`) ; rien n'a tourné avec un vrai Docker sans root.

**Pourquoi** : avec Docker « sans root » (rootless), le démon tourne sous un utilisateur ordinaire. Une évasion d'un conteneur ou une compromission de l'outil ne donne que les droits de cet utilisateur, pas ceux de root. Le Docker de rag-saas (avec root) n'est pas touché : c'est un second démon, séparé, qui ne voit ni ses conteneurs ni ses volumes.

**Ce qui change** : l'application n'est plus dans un conteneur. `docker-compose.hote.yml` ne contient que la base (publiée sur `127.0.0.1:5433` ; même nom de volume que la variante complète, mais sur le Docker sans root c'est un volume neuf : voir « Migrer depuis le déploiement des sections 1 à 8 » plus bas), l'outil tourne sous systemd (`deploy/review-agent.service`) sous l'utilisateur `review`, et chaque agent tourne dans un conteneur jetable (section 10). Avec `AGENT_CONTAINER_USER=auto` (défaut), l'outil détecte Docker sans root et lance alors le conteneur en « root du conteneur » : pour la machine, c'est l'utilisateur `review`, le seul à pouvoir écrire dans le dossier de travail (l'UID 1000 du conteneur serait un sous-UID sans droit d'écriture). Toutes les capacités Linux sont retirées : ce « root » n'a que les droits de `review` sur ses propres fichiers.

**Mise en place (une fois).** Les étapes 1 et 2 demandent `sudo`, les suivantes se font en tant que `review`.

1. **L'utilisateur et ses prérequis** (sudo) :
   ```
   sudo adduser --disabled-password --gecos "" review
   sudo apt-get install -y uidmap dbus-user-session
   sudo loginctl enable-linger review
   grep '^review:' /etc/subuid /etc/subgid
   ```
   `adduser` crée `review` sans mot de passe (connexion par clé SSH seulement) : ne l'ajoute **ni à sudo ni au groupe docker**. `uidmap` fournit `newuidmap` et `newgidmap`, dont Docker sans root a besoin pour décaler les UID. `dbus-user-session` permet les services systemd utilisateur. `enable-linger` garde ses services actifs sans session ouverte et les relance au démarrage de la machine. `grep` doit afficher une plage dans chacun des deux fichiers (ex. `review:100000:65536`) ; sinon `sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 review`, avec une plage qui ne chevauche aucune autre (`cat /etc/subuid`).
2. **Délégation des plafonds de ressources** (sudo) :
   ```
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   ```
   Sans cette délégation, Docker sans root **ignore** les plafonds de mémoire, de processeurs et de processus (il affiche un simple avertissement) : toute la protection contre un agent gourmand disparaît. `mkdir -p` crée le dossier de configuration, `printf ... | sudo tee` écrit le fichier (le `tee` en sudo, car une redirection `>` s'exécuterait sans sudo), `daemon-reload` relit la configuration de systemd. Déconnecte puis reconnecte `review` ensuite.
3. **Docker sans root** (en tant que `review`) :
   ```
   curl -fsSL https://get.docker.com/rootless -o rootless-install.sh
   less rootless-install.sh
   sh rootless-install.sh
   ```
   C'est le script officiel de Docker : on le télécharge, on le lit (`less`), puis on l'exécute, plutôt que de le passer directement à un shell. Il installe les programmes dans `~/bin`, crée le service utilisateur `docker` et affiche deux lignes à ajouter à `~/.bashrc` (`export PATH=$HOME/bin:$PATH` et `export DOCKER_HOST=unix:///run/user/<UID>/docker.sock`). Ensuite `systemctl --user enable --now docker` l'active et le lance. Ubuntu récent restreint les espaces de noms utilisateur non privilégiés : si le démon refuse de démarrer pour cette raison, Docker documente un profil AppArmor pour `rootlesskit` (page « Run the Docker daemon as a non-root user (Rootless mode) »), non essayé ici. Le script n'installe pas toujours `docker compose` : vérifie `docker compose version`, sinon installe le binaire officiel (https://github.com/docker/compose/releases) dans `~/.docker/cli-plugins/docker-compose` (`chmod +x`).
4. **Vérifier que c'est bien sans root et que les plafonds s'appliquent** :
   ```
   docker info --format '{{.SecurityOptions}}'
   docker run --rm --memory 64m alpine cat /sys/fs/cgroup/memory.max
   ```
   La première doit contenir `name=rootless`. La seconde télécharge une petite image et doit afficher `67108864` (64 Mo) : si elle affiche `max`, la délégation de l'étape 2 n'est pas active.
5. **L'outil** : installe Node 24 en le plaçant dans `/usr/bin` (paquet NodeSource ; sinon adapte `ExecStart` dans l'unité au chemin donné par `which node`), clone le dépôt dans `/home/review/review-agent`, puis :
   ```
   cd ~/review-agent
   npm ci
   npx tsc -p tsconfig.build.json
   ```
   `npm ci` installe exactement les dépendances du fichier de verrouillage, `tsc` compile vers `dist/`.
6. **Le `.env`** (`chmod 600`, **tu le remplis toi-même**, je n'y touche pas) : en plus de la section 4, `DATABASE_URL=postgres://review:<POSTGRES_PASSWORD>@127.0.0.1:5433/review_agent` (même mot de passe que `POSTGRES_PASSWORD`), `AGENT_RUNTIME=docker` et `AGENT_IMAGE=review-agent-sandbox:local`. Pas de `HOST`, `PORT` ni `DATA_DIR` : le service les fixe.
7. **La base et l'image des agents** :
   ```
   COMPOSE_FILE=docker-compose.hote.yml docker compose up -d
   docker build -f Dockerfile.agent -t review-agent-sandbox:local --build-arg AGENT_PACKAGES="php-cli php-mbstring php-xml unzip" .
   ```
   `COMPOSE_FILE=...` choisit le fichier compose de cette variante pour la commande (`docker compose` lit le `.env` du dossier, c'est ainsi que `POSTGRES_PASSWORD` arrive). Le `build` télécharge des paquets (plusieurs minutes) ; `--build-arg` ajoute les outils de tes projets (à adapter, voir section 10).
8. **Le service** :
   ```
   mkdir -p ~/.config/systemd/user
   cp deploy/review-agent.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now review-agent
   journalctl --user -u review-agent -f
   ```
   Le fichier est copié dans le dossier des services de l'utilisateur, `daemon-reload` le prend en compte, `enable --now` le lance et le programme au démarrage, `journalctl -f` suit le journal : on y lit `app.started`.
9. **Contrôles** : `ss -tlnp | grep -E '4321|5433'` ne montre que `127.0.0.1`. Dans le dashboard : Paramètres > Modèles > **Clé API**, puis Paramètres > Agents dans des conteneurs > **Tester les conteneurs** (section 10) : les sept contrôles doivent être `ok` (il revérifie l'écriture dans le dossier de travail et les plafonds de l'étape 4, avec la vraie configuration). Lance ensuite une review : `docker ps` montre un conteneur `ra-agent-...` pendant la tâche, et plus rien après.

**Migrer depuis le déploiement des sections 1 à 8** (application déjà lancée dans son conteneur)

À savoir avant de commencer :
- **Le Docker sans root est un autre démon** : ses volumes sont séparés de ceux du Docker de la machine. Le `pgdata` actuel n'y est pas vu : sans les étapes ci-dessous, la base démarre vide (projets, réglages et jetons enregistrés à ressaisir). Le volume `appdata` (copies de dépôts, journaux, session de la CLI) ne suit pas non plus : les copies de dépôts se recréent seules.
- **Le port 4321 est pris** par le conteneur `app` actuel : il faut l'arrêter avant l'étape 8, sinon le service ne démarre pas.
- **Le mode conteneur exige le mode clé API** (section 10) : la session d'abonnement du déploiement actuel ne sert plus. Il faut une clé Anthropic facturée à l'usage (Paramètres > Modèles > Clé API).
- **Le `.env`** : reprends celui du déploiement actuel avec la **même** `SECRETS_MASTER_KEY` (sinon les jetons enregistrés sont illisibles), et ajoute les lignes de l'étape 6. Ne supprime pas `AGENT_RUNTIME` : sans cette ligne l'outil retombe sur le mode machine, sans conteneurs.

Ordre :
1. **Sauvegarder et arrêter l'ancien déploiement**, dans son dossier, avec l'utilisateur qui le lance : `bash scripts/backup.sh` puis `docker compose down`. `backup.sh` écrit `backups/review_agent_<date>.sql.gz`. `down` supprime les conteneurs et réseaux mais **garde les volumes** : n'ajoute jamais `-v` ni `--volumes`, qui supprimeraient la base. Les volumes restent le filet de sécurité tant que la variante n'a pas fait ses preuves.
2. **Étapes 1 à 8** de la mise en place ci-dessus. Le service démarre sur une base vide et applique ses migrations.
3. **Copier la sauvegarde chez `review`** (sudo) : `sudo install -d -o review -g review -m 700 /home/review/review-agent/backups` puis `sudo install -o review -g review -m 600 backups/review_agent_<date>.sql.gz /home/review/review-agent/backups/`. `install -d` crée le dossier avec son propriétaire et ses droits, `install -o -g -m` copie le fichier en fixant propriétaire, groupe et droits en une commande.
4. **Restaurer**, en tant que `review` dans `~/review-agent` : `COMPOSE_FILE=docker-compose.hote.yml APP_UNIT=review-agent bash scripts/restore.sh backups/review_agent_<date>.sql.gz --yes`. Le script arrête le service, recrée la base, recharge la sauvegarde et relance le service (il faut donc que le service de l'étape 8 existe déjà).
5. **Contrôles** de l'étape 9.

Retour arrière : `systemctl --user stop review-agent` (libère le port 4321), puis `docker compose up -d` dans le dossier de l'ancien déploiement. Garde les anciens volumes quelques jours avant de les supprimer.

**Au quotidien dans cette variante**
- **Accès** : tunnel SSH comme à la section 6.
- **Sauvegarde** : `COMPOSE_FILE=docker-compose.hote.yml bash scripts/backup.sh`. Dans un `crontab`, rien n'est hérité de ton shell : mets `COMPOSE_FILE`, `PATH=$HOME/bin:/usr/bin:/bin` et `DOCKER_HOST=unix:///run/user/<UID>/docker.sock` sur la ligne (`id -u` donne l'UID de `review`).
- **Restauration** : `COMPOSE_FILE=docker-compose.hote.yml APP_UNIT=review-agent bash scripts/restore.sh backups/<fichier>.sql.gz --yes` (`APP_UNIT` : le service systemd arrêté puis relancé à la place du service compose `app`). Destructif : essaie-la une fois avant d'en avoir besoin.
- **Import de ta base locale** (section 5 bis) : `systemctl --user stop review-agent`, `node --env-file=.env dist/cli/importSqlite.js ~/review-agent.sqlite`, `systemctl --user start review-agent`.
- **Mise à jour** : sauvegarde, `git pull`, `npm ci`, `npx tsc -p tsconfig.build.json`, reconstruire l'image des agents si `Dockerfile.agent` ou la version de la CLI a changé, `systemctl --user restart review-agent`.

**Mémoire** : base 0,5 Go, outil 1 Go au plus (`MemoryMax` de l'unité), un agent 1,5 Go (`AGENT_MEMORY`, un seul à la fois), soit environ 3 Go sur les 5 Go libres du VPS. Ne monte pas `MAX_CONCURRENT_AGENTS` sans regarder `free -h`.

**Ce que ça protège, et ce que ça ne protège pas**
- Une compromission de l'outil donne les droits de `review` : son `.env`, ses données, son Docker. Ni root, ni rag-saas (autre démon, autres fichiers), tant que `review` n'a pas de `sudo` et n'est pas dans le groupe `docker` du Docker avec root.
- Un agent ne voit que son dossier de travail et ne reçoit que la clé API de la personne. Cette clé reste lisible par son propre agent et le réseau n'est pas filtré (D7) : une clé par personne avec un budget plafonné chez Anthropic limite le risque.
- Non couvert : liste blanche réseau (D7), isolation renforcée de type gVisor (G1), terminal (D8).

## 12. Liste de vérification avant d'inviter quelqu'un

- [ ] `.env` en `chmod 600`, jamais dans git ; `SECRETS_MASTER_KEY` sauvegardée à part.
- [ ] `ss -tlnp | grep 4321` : `127.0.0.1` seulement.
- [ ] La connexion OAuth est active (`AUTH_*` renseigné) : sans session, `curl http://127.0.0.1:4321/api/stats` répond 401.
- [ ] Une sauvegarde existe **et** une restauration a été essayée.
- [ ] `free -h` : au moins 1,5 Go de mémoire disponible une fois la pile démarrée.
- [ ] Les personnes entrent **sur invitation** (Paramètres > Équipe : lien à usage unique, rôle voulu, de préférence réservé à un compte de forge) : `AUTH_ALLOWED_USERS` reste vide ou ne contient que des personnes de confiance. Chaque personne a le bon rôle : un **membre** lance les agents, seul un **administrateur** règle l'espace et les commandes autorisées des projets.
- [ ] L'espace de l'installation a été **transformé en espace d'équipe** (Paramètres > Équipe) avant la première invitation : on n'invite pas dans un espace personnel. La transformation ne se défait pas.
- [ ] Derrière un reverse proxy (Caddy, nginx) : `TRUST_PROXY=true` dans le `.env`, et `PUBLIC_URL` en https (le cookie de session reçoit alors `Secure`). Sans proxy : `TRUST_PROXY` reste à `false`. La limite de 30 tentatives de connexion par 10 minutes et par adresse en dépend.
- [ ] Des limites par personne sont réglées avant d'inviter (Paramètres > Modèles : budget du mois en mode clé API, agents par jour dans les deux modes), surtout sur un abonnement partagé.
- [ ] Si les agents tournent en conteneurs (section 11) : `review` n'est ni dans `sudo` ni dans le groupe `docker`, `docker info` contient `name=rootless`, et le test de plafond mémoire de l'étape 4 affiche bien `67108864`.
