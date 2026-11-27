# Déploiement sur le VPS (pilote)

Statut au 2026-11-26 : **la variante de la section 11 (outil sous systemd, Docker sans root) est en service sur le VPS depuis le 2026-11-23** : le test de conteneurs du dashboard affiche ses sept contrôles `ok` et le tableau de bord s'ouvre par tunnel SSH. L'ancien déploiement décrit aux sections 1 à 8 (l'application dans son conteneur) avait tourné avant ; il a été arrêté le 2026-11-19 sans supprimer ses volumes. Reste à voir une vraie review dans un conteneur (`docker ps` pendant la tâche), puis D7 et G1 (section 11).

Fichiers : `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `tsconfig.build.json`, `scripts/backup.sh`, `scripts/restore.sh`. Variante avec les agents en conteneurs (décidée le 2026-11-12, en service sur le VPS depuis le 2026-11-23) : `Dockerfile.agent`, `docker-compose.hote.yml`, `deploy/review-agent.service`, voir la section 11.

**Les agents tournent en conteneurs (décidé le 2026-11-19).** `AGENT_RUNTIME` vaut `docker` par défaut, et `AGENT_RUNTIME=host` est **refusé au démarrage dès qu'une connexion par compte est configurée** (`AUTH_*` ou email) : avec des comptes, d'autres personnes lancent des agents, qui ne doivent jamais tourner sur la machine sans isolation. Conséquence : le déploiement des sections 1 à 8 (l'application dans son conteneur, sans accès à Docker) ne peut lancer d'agents **qu'en mode machine, sans comptes** (`AGENT_RUNTIME=host` écrit dans le `.env`, usage d'une seule personne par tunnel SSH). **Dès qu'il y a des comptes, c'est la section 11** (l'outil sur la machine, Docker sans root). L'abonnement Claude y passe par un jeton, voir « Abonnement Claude dans les conteneurs » à la section 10.

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
| `AUTH_*` | connexion par compte de forge (fortement recommandée) : `AUTH_GITHUB_CLIENT_ID` + `AUTH_GITHUB_CLIENT_SECRET` (et/ou `AUTH_GITLAB_*` avec `GITLAB_URL`) et `AUTH_OWNER=github:<login>` | créer l'application OAuth et lire le détail dans `docs/a-tester.md`, section 5 (adresse de retour : `<PUBLIC_URL>/auth/github/callback`) |
| `AGENT_RUNTIME` | `host` : seul mode possible ici (l'application est dans son conteneur, sans Docker), **refusé si `AUTH_*` ou l'email est configuré** (section 11) | à écrire explicitement : le défaut est `docker` |
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

**Ne concerne que le mode machine (`AGENT_RUNTIME=host`, sans comptes).** Avec les agents en conteneurs (défaut, obligatoire avec des comptes), l'abonnement passe par un jeton `claude setup-token` : voir la section 10. Le terminal du navigateur y tourne lui aussi dans un conteneur, où une connexion `/login` n'est pas conservée.

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
- **Dans ce déploiement (sections 1 à 8, mode machine, sans comptes), tous les agents tournent dans le même conteneur**, avec le même utilisateur système que l'application. Avec des comptes, ce mode est refusé au démarrage : section 11. Les secrets du `.env` sont retirés de l'environnement des agents (jetons, clé maître, adresse de la base, secrets OAuth) : une commande qui affiche son environnement ne les voit pas. **Ce n'est pas une isolation** : un processus du même utilisateur peut lire l'environnement de son processus parent (`/proc`) et les fichiers du volume de données, dont les copies de dépôts des autres personnes. Tant que les conteneurs par personne (lot D) n'existent pas : **personnes de confiance seulement**.
- Pas de limite de mémoire par agent (seulement celle du conteneur entier) ni d'isolation réseau des agents.
- Les journaux sont dans le volume (`/app/data/logs`), sans rotation. À surveiller si le disque se remplit.
- Rien n'a été essayé sur le vrai VPS : coexistence avec rag-saas, mémoire réelle, durée du build.

## 10. Agents dans des conteneurs (lot D, première tranche)

`AGENT_RUNTIME=docker` (défaut depuis le 2026-11-19 ; variables `AGENT_*` du `.env.example`) fait tourner chaque review, chaque tâche de dev et le terminal du navigateur dans un **conteneur jetable** créé pour la tâche et supprimé ensuite. Le conteneur : système de fichiers en lecture seule (sauf `/tmp` et le dossier personnel de l'agent, en mémoire), aucune capacité Linux, pas d'élévation de droits, mémoire, processeurs et processus plafonnés, utilisateur sans droits. Il ne monte **que** le dossier de travail de la tâche. Il ne reçoit ni la base, ni la clé maître, ni les jetons de forge, ni les dossiers des autres personnes, ni l'environnement de l'outil : seulement les identifiants Claude de la personne (sa clé API, ou son jeton d'abonnement). Vérifié avec le vrai Docker sur une image locale (utilisateur 1000, racine en lecture seule, capacités à zéro, `no_new_privs`, jeton de forge absent).

**Ce que ça exige**
- Une **connexion à Claude** transmise au conteneur : en mode clé API, la clé de la personne ; en mode abonnement, son **jeton d'abonnement** (voir ci-dessous). Sans l'un ou l'autre, l'outil **refuse** de lancer l'agent plutôt que de retomber sur la machine.
- Une **image** qui contient la CLI Claude Code (`claude`) **et** les outils des projets, construite avec `Dockerfile.agent` (Node, git, la CLI) : `docker build -f Dockerfile.agent -t review-agent-sandbox:local .` (nom par défaut de `AGENT_IMAGE`). Les outils de tes projets s'ajoutent avec `--build-arg AGENT_PACKAGES="php-cli php-mbstring php-xml unzip"`. Ce sont les paquets de Debian bookworm (PHP 8.2 par exemple) : un projet qui exige une autre version (PHP 7.3...) a besoin de sa propre image (voir « Une image par projet » plus bas). L'image n'est jamais téléchargée au lancement d'une tâche (`--pull never`).
- L'outil doit pouvoir lancer `docker`.

**Abonnement Claude dans les conteneurs (2026-11-19)**
- Le dossier personnel de la machine (`~/.claude`, où vit une session `/login`) n'est **jamais monté** dans un conteneur : il donnerait à chaque agent, y compris manipulé par le contenu d'un ticket, une session complète. À la place, chaque personne enregistre un **jeton d'abonnement** : `claude setup-token` sur son poste (commande officielle de la CLI, jeton valable un an, limité aux requêtes de modèle), à coller dans Paramètres > Connexion > « Jeton d'abonnement Claude ». Le propriétaire peut aussi le mettre dans le `.env` (`CLAUDE_CODE_OAUTH_TOKEN`, prioritaire).
- Le jeton est chiffré dans le coffre (comme les jetons de forge), propre à la personne et à son espace : un membre n'a jamais celui du propriétaire. Il est transmis au seul conteneur de **ses** tâches, par l'environnement du client `docker` (jamais dans les arguments, visibles de tous par `ps`), puis le conteneur est supprimé. Il est masqué dans les erreurs et les journaux.
- Même niveau d'exposition que la clé API : le jeton est lisible par l'agent de la personne (il en a besoin) et, sans filtre du réseau sortant (D7), un agent manipulé pourrait l'envoyer ailleurs. Le jeton vaut un an ; s'il fuit, génères-en un nouveau (`claude setup-token`) et remplace-le ici (la révocation de l'ancien côté Anthropic n'a pas été vérifiée).
- **Décision renversée** : le 2026-11-09, ce jeton avait été « non retenu » (secrets sensibles centralisés, conditions d'utilisation incertaines). Il est retenu le 2026-11-19 à la demande du propriétaire, qui veut des conteneurs partout **et** son abonnement. Les conditions d'utilisation restent **à faire valider par Anthropic** avant d'ouvrir au-delà de l'équipe (chaque personne n'utilise que son propre abonnement, par la CLI officielle).
- Le terminal du navigateur (réservé au propriétaire) tourne dans un conteneur du même type, avec ce jeton. Une connexion `/login` faite dedans n'est pas conservée. La pastille « connecté » vient de la présence du jeton, pas d'un contrôle auprès d'Anthropic.

**Vérifier que tout est prêt** : dans le dashboard, Paramètres > **Agents dans des conteneurs** > **Tester les conteneurs**. L'outil lance un conteneur d'essai avec les options exactes d'une vraie tâche et affiche sept contrôles : connexion à Claude (jeton d'abonnement ou clé API selon le mode choisi), Docker (version, avec ou sans root), image présente, écriture dans le dossier de travail, isolation (système de fichiers en lecture seule, capacités retirées, pas d'élévation de droits), plafonds de mémoire et de processus réellement appliqués, CLI Claude Code présente. Chaque échec dit quoi faire. Le test dure quelques secondes, ne touche à aucun réglage, et supprime son conteneur et son dossier d'essai ensuite.

**Une image par projet** : tes projets n'ont pas tous les mêmes outils (PHP 7.1, 7.3, 8.2...). Construis une image par pile (la CLI Claude Code, qui demande Node, plus les outils du projet ; `Dockerfile.agent` sert de modèle), ajoute leurs noms à `AGENT_IMAGES` dans le `.env` (séparés par des virgules), redémarre l'outil, puis choisis l'image du projet dans Paramètres > Projets > Modifier > Image de l'agent. Sans choix, c'est `AGENT_IMAGE`. Seules les images de `AGENT_IMAGE` et `AGENT_IMAGES` sont permises : le `.env` reste seul maître de la liste, sinon un réglage de projet pourrait lancer n'importe quelle image présente sur la machine. Une image non autorisée est refusée à l'enregistrement du projet et, par sécurité, au lancement de chaque tâche (elle échoue avec la raison). Le bouton « Tester » de la section des conteneurs essaie chaque image séparément.
- Dans un conteneur il n'y a pas de Docker : les « Commandes autorisées » du projet doivent appeler directement les outils de l'image (`vendor/bin/phpunit`), et non `docker run ... php:7.3-cli vendor/bin/phpunit` comme en mode machine. `{worktree}` ne sert pas dans ce mode.
- Les paquets de Debian bookworm n'incluent pas PHP 7.3 : pour un projet en PHP 7.3 ou plus ancien, il faut partir d'une image du projet (par exemple `php:7.3-cli`) et y installer Node et la CLI Claude Code. Non essayé ici.

**Décision de déploiement (2026-11-12) : l'outil sur la machine, avec Docker sans root**
Lancer des conteneurs, c'est pouvoir être root sur la machine : le processus qui lance `docker` est de confiance. L'application dans son conteneur (le `docker-compose.yml` des sections 1 à 8) n'a **pas** accès à Docker et ne peut donc pas utiliser ce mode. Deux voies existaient, la première est **retenue** :
1. L'outil tourne sur la machine sous un utilisateur dédié avec **Docker sans root** (rootless) ; seule la base reste dans compose. Une compromission de l'outil ne donne alors pas root. Mise en place à la section 11.
2. L'application reste dans son conteneur avec le socket Docker monté : plus simple, mais le conteneur de l'application devient équivalent à root sur la machine. Un proxy de socket n'y change rien (il ne peut pas filtrer les dossiers montés). **Écartée.**
Tant que la section 11 n'est pas appliquée, les agents du déploiement Docker des sections 1 à 8 tournent comme avant (dans le conteneur de l'application, avec la limite expliquée plus haut).

**Limites**
- La clé API ou le jeton d'abonnement de la personne est visible de son propre agent (il en a besoin) : sans filtre du réseau sortant (D7), un agent manipulé pourrait l'envoyer ailleurs. Une clé par personne avec un budget limité chez Anthropic réduit ce risque ; pour le jeton d'abonnement, il se refait avec `claude setup-token`.
- Le dossier de travail est un `git worktree` : son dépôt est ailleurs sur la machine, donc les commandes `git` de l'agent dans le conteneur échouent (lire, chercher et modifier des fichiers marchent ; l'outil fait lui-même les commits et le push).
- Le réseau est celui par défaut de Docker (accès à Internet). Pas encore de liste blanche (D7), ni de terminal (D8), ni de modèles d'environnement partagés (D9).
- La reprise d'une session d'agent (« Reprendre la main ») n'existe pas en mode conteneur : sa session ne survit pas à la tâche.

## 11. Variante avec les agents en conteneurs : l'outil sur la machine, Docker sans root

**Statut (2026-11-26) : en service sur le VPS, étapes 1 à 9 faites** (voir les journaux des trois essais plus bas). Le test de conteneurs du dashboard affiche ses sept contrôles `ok` (jeton, Docker sans root, image, dossier de travail, isolation, capacités, CLI) et l'ancienne base a été restaurée. **Pas encore vu** : une vraie review dans un conteneur de bout en bout (`docker ps` pendant la tâche). Le code est aussi testé avec un faux `docker`.

**Deux pièges constatés au déploiement** : (1) `PrivateTmp=true` coupe l'accès au Docker sans root : l'unité du dépôt ne l'a plus depuis le 2026-11-27, mais une copie installée avant cette date peut encore l'avoir (étape 8) ; (2) après une restauration, le mode d'action des reviews revient à celui de l'ancienne base, qui peut être `auto` (étape 9).

**Comprendre en bref**
- **Le compte `review` fait tourner l'outil entier** : dashboard, files d'attente, agents de dev **et** agents de review. Son nom n'a aucun lien particulier avec les agents de review : c'est une étiquette (compte de service). Un autre nom marche (l'unité systemd utilise `%h`, le dossier personnel du compte), à condition de remplacer `review` et `/home/review` dans les commandes ci-dessous. Sur le VPS du 2026-11-19, le compte créé s'appelle `review`.
- **Pourquoi un compte dédié** : l'outil lance des conteneurs, donc il lui faut Docker. Avec un Docker à droits complets (root), qui compromet l'outil ou s'échappe d'un conteneur devient root sur toute la machine. Le compte `review` n'a ni `sudo` ni groupe `docker`, et son Docker « sans root » ne donne que les droits de `review`. Il n'a pas de mot de passe : c'est un compte de service, on y entre depuis une session `ubuntu` (`machinectl`) ou par clé SSH.
- **Un conteneur par tâche, pas par projet** : chaque tâche (agent de dev ou de review) a son conteneur jetable, détruit à la fin. Un conteneur de projet qui resterait en vie garderait ce qu'un agent manipulé y laisse pour les tâches suivantes (d'autres personnes comprises), garderait le jeton d'une personne pour les tâches des autres, et occuperait de la mémoire (environ 3 Go de marge sur le VPS). Ce qui est **par projet**, c'est l'**image** (les outils : PHP 7.3, PHP 8.4...), voir « Une image par projet » à la section 10 : le conteneur est recréé à chaque tâche à partir de cette image. Un conteneur persistant avec arrêt à l'inactivité est prévu plus tard (`docs/roadmap-plateforme.md`, D2).

**Pourquoi** : avec Docker « sans root » (rootless), le démon tourne sous un utilisateur ordinaire. Une évasion d'un conteneur ou une compromission de l'outil ne donne que les droits de cet utilisateur, pas ceux de root. Le Docker de rag-saas (avec root) n'est pas touché : c'est un second démon, séparé, qui ne voit ni ses conteneurs ni ses volumes.

**Ce qui change** : l'application n'est plus dans un conteneur. `docker-compose.hote.yml` ne contient que la base (publiée sur `127.0.0.1:5433` ; même nom de volume que la variante complète, mais sur le Docker sans root c'est un volume neuf : voir « Migrer depuis le déploiement des sections 1 à 8 » plus bas), l'outil tourne sous systemd (`deploy/review-agent.service`) sous l'utilisateur `review`, et chaque agent tourne dans un conteneur jetable (section 10). Avec `AGENT_CONTAINER_USER=auto` (défaut), l'outil détecte Docker sans root et lance alors le conteneur en « root du conteneur » : pour la machine, c'est l'utilisateur `review`, le seul à pouvoir écrire dans le dossier de travail (l'UID 1000 du conteneur serait un sous-UID sans droit d'écriture). Toutes les capacités Linux sont retirées : ce « root » n'a que les droits de `review` sur ses propres fichiers.

**Mise en place (une fois).** Les étapes 1 et 2, le profil AppArmor de l'étape 3 et l'installation de Node de l'étape 5 demandent `sudo` (depuis la session `ubuntu`) ; le reste se fait en tant que `review`, dans une vraie session ouverte comme expliqué à la fin de l'étape 2. Une session `review` démarre toujours dans `/home/review` : après chaque ouverture, faire `cd ~/review-agent` avant les commandes de l'outil (étapes 5 à 9).

1. **L'utilisateur et ses prérequis** (sudo) :
   ```
   sudo adduser --disabled-password --gecos "" review
   sudo apt-get install -y uidmap dbus-user-session
   sudo loginctl enable-linger review
   grep '^review:' /etc/subuid /etc/subgid
   ```
   `adduser` crée `review` sans mot de passe (aucune connexion par mot de passe n'est possible : on y entre par `machinectl` ou par clé SSH, voir la fin de l'étape 2) : ne l'ajoute **ni à sudo ni au groupe docker**. `uidmap` fournit `newuidmap` et `newgidmap`, dont Docker sans root a besoin pour décaler les UID. `dbus-user-session` permet les services systemd utilisateur. `enable-linger` garde ses services actifs sans session ouverte et les relance au démarrage de la machine. `grep` doit afficher une plage dans chacun des deux fichiers (ex. `review:100000:65536`) ; sinon `sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 review`, avec une plage qui ne chevauche aucune autre (`cat /etc/subuid`).
2. **Délégation des plafonds de ressources** (sudo) :
   ```
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   sudo systemctl restart user@$(id -u review).service
   ```
   Sans cette délégation, Docker sans root **ignore** les plafonds de mémoire, de processeurs et de processus (il affiche un simple avertissement) : toute la protection contre un agent gourmand disparaît. `mkdir -p` crée le dossier de configuration, `printf ... | sudo tee` écrit le fichier (le `tee` en sudo, car une redirection `>` s'exécuterait sans sudo), `daemon-reload` relit la configuration de systemd. `id -u review` donne le numéro de `review` et `user@<numéro>.service` est son gestionnaire de services : `enable-linger` (étape 1) l'a déjà démarré sans la délégation, et se reconnecter ne le relance pas, d'où le `restart` (inoffensif tant que rien ne tourne sous `review`). Le test de plafond mémoire de l'étape 4 confirme que la délégation est active (vérifié le 2026-11-20 : `cpuset cpu io memory pids` sont délégués et le plafond de 64 Mo est appliqué).

   **Ouvrir une session en tant que `review`** (avant l'étape 3). Docker sans root et `systemctl --user` demandent une vraie session de connexion : `su` ou `sudo -u review` ne la donnent pas de façon fiable. Deux façons :
   - **Sans clé SSH, depuis la session `ubuntu`** (la plus simple) : `sudo apt-get install -y systemd-container` puis `sudo machinectl shell review@`. `systemd-container` fournit `machinectl`, et `shell review@` ouvre une session de connexion de `review` sur cette machine (`exit` pour en sortir). Vérifier dans cette session : `whoami` affiche `review`, et `echo $XDG_RUNTIME_DIR` affiche un dossier du genre `/run/user/1001` (vide : la session n'est pas bonne).
   - **Par SSH avec une clé** : il faut qu'une clé publique soit dans `/home/review/.ssh/authorized_keys`. Copier celles de `ubuntu` (`sudo install -d -m 700 -o review -g review /home/review/.ssh`, puis `sudo cp ~/.ssh/authorized_keys /home/review/.ssh/authorized_keys`, `sudo chown review:review` et `sudo chmod 600` sur ce fichier) ne marche que si `ubuntu` se connecte lui-même par clé : `sudo wc -c ~/.ssh/authorized_keys` affiche `0` s'il est vide. Sinon, générer une clé sur le poste (`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_review`, la partie `.pub` est la clé publique), l'ajouter avec `echo 'ssh-ed25519 AAAA...' | sudo tee -a /home/review/.ssh/authorized_keys` (`-a` ajoute sans écraser), puis `ssh -i ~/.ssh/id_ed25519_review review@<ip>`.
   - Ne jamais essayer un mot de passe pour `review` : il n'existe pas, et des essais répétés peuvent faire bannir ton adresse.
3. **Docker sans root** (en tant que `review`) :
   ```
   curl -fsSL https://get.docker.com/rootless -o rootless-install.sh
   less rootless-install.sh
   sh rootless-install.sh
   ```
   C'est le script officiel de Docker : on le télécharge, on le lit (`less`), puis on l'exécute, plutôt que de le passer directement à un shell. Il installe les programmes dans `~/bin`, puis appelle `dockerd-rootless-setuptool.sh install`, qui crée le service utilisateur `docker`, le démarre, l'active au démarrage et crée le contexte CLI `rootless`. À la fin il affiche deux lignes à ajouter à `~/.bashrc`, que l'on ajoute et applique avec :
   ```
   echo 'export PATH=/home/review/bin:$PATH' >> ~/.bashrc
   echo 'export DOCKER_HOST=unix:///run/user/<UID>/docker.sock' >> ~/.bashrc
   source ~/.bashrc
   ```
   (`>>` ajoute à la fin sans écraser ; les guillemets simples empêchent le remplacement de `$PATH` à ce moment-là ; `<UID>` est le numéro donné par `id -u`, 1001 sur le VPS du 2026-11-19.)

   **Ubuntu 26.04 : le script échoue sans profil AppArmor (constaté le 2026-11-20).** Ubuntu récent restreint les espaces de noms utilisateur non privilégiés (`apparmor_restrict_unprivileged_userns=1`). Le script s'arrête sur `[rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: permission denied` et affiche lui-même la correction (profil AppArmor pour `rootlesskit`, documenté par Docker). Depuis la session `ubuntu` (sudo) :
   ```
   cat <<EOT | sudo tee "/etc/apparmor.d/home.review.bin.rootlesskit"
   abi <abi/4.0>,
   include <tunables/global>

   /home/review/bin/rootlesskit flags=(unconfined) {
     userns,

     include if exists <local/home.review.bin.rootlesskit>
   }
   EOT
   sudo apparmor_parser -r /etc/apparmor.d/home.review.bin.rootlesskit
   ```
   `cat <<EOT | sudo tee` écrit le texte dans `/etc/apparmor.d/` avec les droits root (un `>` simple s'exécuterait sans `sudo`). Le profil ne vise que le programme `/home/review/bin/rootlesskit` : `userns,` lui permet de créer des espaces de noms utilisateur, `flags=(unconfined)` ne lui ajoute aucune autre restriction, et le reste de la machine garde la restriction. Le nom du fichier et le chemin dépendent du compte : pour un autre nom que `review`, les adapter. `apparmor_parser -r` charge ou remplace ce seul profil ; on le préfère au `sudo systemctl restart apparmor.service` suggéré par le script, qui recharge tous les profils de la machine (dont ceux que peut utiliser le Docker avec root). Au prochain démarrage, le profil est rechargé depuis `/etc/apparmor.d/`.

   Relancer ensuite `sh rootless-install.sh` s'arrête sur `Existing rootless Docker detected at /home/review/bin/dockerd` : les programmes de la première tentative sont déjà là. Dans la session `review`, lancer directement l'étape qui avait échoué :
   ```
   PATH=$HOME/bin:$PATH dockerd-rootless-setuptool.sh install
   ```
   (`PATH=... commande` ajoute `~/bin` au chemin de recherche pour cette seule commande.) Il doit finir sur `Installed docker.service successfully.` et les deux lignes `export` ci-dessus. Alternative proposée par le script : `systemctl --user stop docker`, `rm -f ~/bin/dockerd`, puis relancer `sh rootless-install.sh`. Versions obtenues le 2026-11-20 : Docker 29.10.0, rootlesskit 3.3.0, `docker compose` v5.6.1.

   Le script n'installe pas toujours `docker compose` : vérifie `docker compose version`, sinon installe le binaire officiel (https://github.com/docker/compose/releases) dans `~/.docker/cli-plugins/docker-compose` (`chmod +x`).
4. **Vérifier que c'est bien sans root et que les plafonds s'appliquent** :
   ```
   docker info --format '{{.SecurityOptions}}'
   docker run --rm --memory 64m alpine cat /sys/fs/cgroup/memory.max
   ```
   La première doit contenir `name=rootless`. La seconde télécharge une petite image et doit afficher `67108864` (64 Mo) : si elle affiche `max`, la délégation de l'étape 2 n'est pas active.
5. **L'outil** : Node 24 est requis (`engines` du `package.json`) et l'unité lance `/usr/bin/node` : on l'installe pour toute la machine avec le paquet NodeSource, **depuis la session `ubuntu`** (sudo) ; sinon, adapter `ExecStart` dans l'unité au chemin donné par `which node`.
   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
   less nodesource_setup.sh
   sudo bash nodesource_setup.sh
   sudo apt-get install -y nodejs
   node -v
   which node
   ```
   `deb.nodesource.com` est le serveur NodeSource pour Debian et Ubuntu. Le script ajoute son dépôt de paquets (clé et liste) à `apt`, `apt-get install` installe Node. `node -v` doit afficher `v24.x.x` et `which node` `/usr/bin/node` (constaté le 2026-11-20 sur Ubuntu 26.04 : `v24.22.3`). Puis, **en tant que `review`**, cloner le dépôt et le compiler :
   ```
   git clone https://github.com/Explonentielle/Agent-review.git ~/review-agent
   cd ~/review-agent
   git log -1 --oneline
   npm ci
   npx tsc -p tsconfig.build.json
   ls dist/index.js
   ```
   Le clone se fait sans identifiants. `git log` doit montrer le dernier commit attendu (`59d8b10` ou plus récent). `npm ci` installe exactement les dépendances du fichier de verrouillage dans `node_modules`, `tsc` compile vers `dist/` (silencieux si tout va bien) et `ls` confirme le fichier que lance le service. Ne pas oublier le `cd ~/review-agent` : lancé dans `/home/review`, `npm ci` échoue avec `EUSAGE ... can only install with an existing package-lock.json`. Les avertissements de `npm ci` (vulnérabilités signalées, `esbuild` sans script d'installation autorisé) ne bloquent rien ; ne pas lancer `npm audit fix`, qui modifierait `package-lock.json` sur le VPS.
6. **Le `.env`** (`chmod 600`, **tu le remplis toi-même**, je n'y touche pas) : en plus de la section 4, `DATABASE_URL=postgres://review:<POSTGRES_PASSWORD>@127.0.0.1:5433/review_agent` (même mot de passe que `POSTGRES_PASSWORD`), `AGENT_RUNTIME=docker` (c'est le défaut, mais écris-le) et `AGENT_IMAGE=review-agent-sandbox:local`. Pas de `HOST`, `PORT` ni `DATA_DIR` : le service les fixe. Ton jeton d'abonnement (`claude setup-token` sur ton poste) peut s'écrire ici en `CLAUDE_CODE_OAUTH_TOKEN=...`, ou se coller ensuite dans le dashboard. Pour partir de l'ancien `.env` (depuis la session `ubuntu`) : `sudo install -o review -g review -m 600 ~/Agent-review/.env /home/review/review-agent/.env`, qui copie le fichier en le donnant à `review`, lisible par lui seul ; puis il se modifie à la main, sans qu'un agent n'y touche.
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

   **Pourquoi l'unité n'a pas `PrivateTmp=true` (constaté sur le VPS le 2026-11-23, corrigé dans le dépôt le 2026-11-27).** Cette option donne au service un `/tmp` privé ; avec elle, l'outil n'atteint pas le Docker sans root et le test de conteneurs échoue. Un essai avec `systemd-run` et `-p PrivateTmp=true` a reproduit le blocage, et la retirer l'a levé. Si ta copie installée date d'avant le 2026-11-27 et contient encore `PrivateTmp=true`, supprime cette ligne dans `~/.config/systemd/user/review-agent.service` puis `systemctl --user daemon-reload` (la copie du VPS est déjà corrigée). `NoNewPrivileges=true` ne pose aucun problème.
9. **Contrôles** : `ss -tlnp | grep -E '4321|5433'` ne montre que `127.0.0.1`. Dans le dashboard : Paramètres > Connexion > **Jeton d'abonnement Claude** (ou la clé API si tu choisis ce mode dans Paramètres > Modèles), puis Paramètres > Agents dans des conteneurs > **Tester les conteneurs** (section 10) : les sept contrôles doivent être `ok` (il revérifie l'écriture dans le dossier de travail et les plafonds de l'étape 4, avec la vraie configuration). Lance ensuite une review : `docker ps` montre un conteneur `ra-agent-...` pendant la tâche, et plus rien après. **Avant cette review, vérifie Paramètres > Mode d'action des reviews** : après une restauration, le réglage est celui de l'ancienne base, qui peut être « Mode auto » (commente **et approuve** seul les reviews mineures). Pour une première review réelle, choisis « Mode ombre » (rien n'est posté sans ton clic).

**Journal du premier essai (2026-11-19)** : VPS sous Ubuntu 26.04, utilisateur `ubuntu` avec Docker classique, ancien déploiement compose dans `~/Agent-review`.
- **Fait** : sauvegarde de l'ancien déploiement (`~/Agent-review/backups/review_agent_2026-11-19_121346.sql.gz`, 36 Ko), puis `docker compose down` sans `-v` (volumes gardés). Aucun `git pull` dans `~/Agent-review` : ce dossier est le retour arrière.
- **Fait** : étape 1 (compte `review` créé, `uidmap` installé, `dbus-user-session` déjà présent, `enable-linger`, plage `165536:65536` dans `/etc/subuid` et `/etc/subgid`) et étape 2 (fichier `/etc/systemd/system/user@.service.d/delegate.conf` écrit, `daemon-reload`).
- **Pas fait** : le `restart` de `user@<numéro>.service` (ajouté à l'étape 2 après coup), l'ouverture de session de `review`, et tout ce qui suit (étapes 3 à 9, puis la migration ci-dessous).
- **Constaté** : `ubuntu` se connecte par mot de passe, son `~/.ssh/authorized_keys` est vide. La copie des clés vers `review` n'a donc rien donné et `ssh review@<ip>` demande un mot de passe qui n'existe pas. D'où la voie `machinectl shell review@`, sans clé.
- **Constaté** : après `apt-get install`, `needrestart` signale un noyau en attente (7.0.0-28 en cours, 7.0.0-43 installé) et des redémarrages de services différés, dont `docker.service`. À ignorer pendant la mise en place : ne pas relancer `docker.service` (c'est le Docker à droits complets), redémarrer la machine plus tard, à un moment calme.
- **Données** : la base n'a pas d'enjeu pour le propriétaire ; la restauration reste conseillée pour garder les réglages et les jetons enregistrés (sinon, les ressaisir dans le dashboard).
- **Jamais vu** : Docker sans root sous Ubuntu 26.04 (espaces de noms utilisateur, AppArmor), les plafonds de mémoire réellement appliqués, la vraie CLI Claude Code avec le jeton `claude setup-token` dans un conteneur au dossier personnel vide, le terminal en conteneur. Noter le message exact de chaque erreur.
- **Pour l'agent qui reprend** : ne jamais lire ni modifier le `.env` (le propriétaire le remplit lui-même) ; ne jamais afficher un jeton ou une clé ; les commandes `sudo` sont jouées par le propriétaire, une explication de chaque commande est attendue avant de la lui donner ; pas de commit ni de push sans demande explicite.

**Journal du deuxième essai (2026-11-20)** : même VPS (Ubuntu 26.04, noyau 7.0.0-28 en cours, 7.0.0-43 installé et en attente de redémarrage).
- **Fait** : délégation systemd vérifiée (`cat /sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/cgroup.controllers` affiche `cpuset cpu io memory pids`), `systemd-container` installé (sans lui : `sudo: 'machinectl': command not found`), session `review` ouverte par `sudo machinectl shell review@` (`XDG_RUNTIME_DIR=/run/user/1001`).
- **Étape 3** : blocage AppArmor comme prévu (message exact et correction ci-dessus), puis `dockerd-rootless-setuptool.sh install` lancé directement après le profil. Le démarrage de `dockerd` affiche des lignes `Deleting nftables ... No such file or directory` de niveau `info` : Docker supprime des règles qui n'existent pas encore, sans conséquence.
- **Étape 4** : `docker info --format '{{.SecurityOptions}}'` donne `[name=seccomp,profile=builtin name=rootless name=cgroupns]` et `docker run --rm --memory 64m alpine cat /sys/fs/cgroup/memory.max` donne `67108864` : le démon est sans root et les plafonds sont appliqués.
- **Étape 5** : Node 24.22.3 par NodeSource (accepté sur Ubuntu 26.04), git 2.53.0, clone en `59d8b10`, `npm ci` (127 paquets, 6 vulnérabilités signalées, non traitées) et `tsc` sans erreur. `ls dist/index.js` n'a pas été confirmé : la connexion SSH s'est coupée juste après (`client_loop: send disconnect: Connection reset`), le service Docker de `review` n'est pas touché (linger).
- **Constaté** : `needrestart` signale toujours le noyau et des redémarrages différés : ne pas relancer `docker.service` (c'est le Docker avec root, partagé avec d'autres applications de la machine).
- **Pas fait** : étapes 6 à 9, restauration de la sauvegarde, jeton d'abonnement, test d'une vraie review. Toujours jamais vu : l'image des agents, la vraie CLI Claude avec le jeton dans un conteneur, le terminal en conteneur.
- **Pour l'agent qui reprend** : se reconnecter en SSH sous `ubuntu`, `sudo machinectl shell review@`, `cd ~/review-agent`, `ls dist/index.js`, puis l'étape 6. Mêmes consignes qu'au premier essai (jamais lire ni modifier le `.env`, jamais afficher un jeton, expliquer chaque commande avant de la donner, pas de commit ni de push sans demande explicite).
**Journal du troisième essai (2026-11-23 et 2026-11-24)** : même VPS, étapes 6 à 9.
- **Fait** : `.env` rempli par le propriétaire, base et image des agents (`review-agent-sandbox:local`), service systemd utilisateur actif (`systemctl --user status review-agent` : `active`), sauvegarde de l'ancien déploiement restaurée, jeton d'abonnement Claude collé dans Paramètres > Connexion.
- **Constaté** : `PrivateTmp=true` de l'unité bloque l'accès au Docker sans root (voir l'étape 8) ; retiré de la copie installée, puis du dépôt le 2026-11-27.
- **Constaté** : le test de conteneurs affiche sept `ok` : jeton, Docker sans root 29.10.0, image, dossier de travail, isolation, capacités, CLI 2.1.330.
- **Constaté** : après `git pull`, un écran récent du dashboard peut appeler une route que le serveur compilé ne connaît pas encore. Le dossier `public/` est lu sur le disque, donc le `git pull` suffit pour lui ; le serveur lance `dist/index.js`, qu'il faut recompiler. L'Intendant affichait « Not Found » (404 de Fastify) pour cette raison le 2026-11-24 : `npx tsc -p tsconfig.build.json` puis `systemctl --user restart review-agent` l'ont réglé.
- **Pas fait** : une vraie review dans un conteneur avec `docker ps` pendant la tâche, `free -h` pendant un agent (la mémoire disponible doit rester au-dessus de 1,5 Go), le redémarrage de la machine pour le noyau en attente, et l'essai de la connexion OAuth GitHub (reporté par le propriétaire le 2026-11-27, `docs/a-tester.md` section 5, `docs/roadmap.md` item 49).
- **Suite prévue après le déploiement** : une vraie review, puis D7 (liste blanche réseau : `AGENT_NETWORK` existe déjà, le reste est de l'infrastructure), puis G1 (gVisor : une option de runtime reste à ajouter à l'outil, qui n'en a pas ; une machine séparée ne sert qu'à séparer l'exécution de l'outil). Voir `docs/roadmap-plateforme.md`.

**Migrer depuis le déploiement des sections 1 à 8** (application déjà lancée dans son conteneur)

À savoir avant de commencer :
- **Le Docker sans root est un autre démon** : ses volumes sont séparés de ceux du Docker de la machine. Le `pgdata` actuel n'y est pas vu : sans les étapes ci-dessous, la base démarre vide (projets, réglages et jetons enregistrés à ressaisir). Le volume `appdata` (copies de dépôts, journaux, session de la CLI) ne suit pas non plus : les copies de dépôts se recréent seules.
- **Le port 4321 est pris** par le conteneur `app` actuel : il faut l'arrêter avant l'étape 8, sinon le service ne démarre pas.
- **La session d'abonnement du déploiement actuel ne sert plus** (section 10) : en conteneur, l'abonnement passe par un jeton. Lance `claude setup-token` sur ton poste, puis colle le jeton dans Paramètres > Connexion > « Jeton d'abonnement Claude » (ou une clé API Anthropic facturée à l'usage, Paramètres > Modèles > Clé API).
- **Le `.env`** : reprends celui du déploiement actuel avec la **même** `SECRETS_MASTER_KEY` (sinon les jetons enregistrés sont illisibles), et ajoute les lignes de l'étape 6. Retire `AGENT_RUNTIME=host` s'il y est : avec des comptes (`AUTH_*`), l'outil refuse de démarrer en mode machine.

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
- **Sauvegarde automatique (minuteur systemd, préparé le 2026-11-27, jamais essayé sur le VPS)** : chaque nuit vers 3 h 30, les 30 plus récentes sont gardées (le même dossier `backups/` reçoit aussi la sauvegarde que `scripts/deploy.sh` fait avant chaque déploiement). Installation, en tant que `review` dans `~/review-agent` :
  ```
  cp deploy/review-agent-backup.service deploy/review-agent-backup.timer ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now review-agent-backup.timer
  systemctl --user start review-agent-backup.service
  ls -lh backups/
  systemctl --user list-timers review-agent-backup.timer
  ```
  `cp` installe les deux fichiers, `daemon-reload` les prend en compte, `enable --now` programme et active le minuteur (il survit aux redémarrages grâce à `enable-linger`, étape 1), `start` lance une sauvegarde tout de suite pour l'essai, `ls` doit montrer un fichier `review_agent_<date>.sql.gz` non vide, et `list-timers` donne la prochaine échéance. Le service passe lui-même `COMPOSE_FILE`, `DOCKER_HOST` et `PATH` (un service systemd n'hérite rien de ta session). En cas d'échec : `journalctl --user -u review-agent-backup.service -n 30`.
  **Ce que ça ne protège pas** : les sauvegardes sont sur le même disque que la base. Elles couvrent une erreur de manipulation, une mauvaise migration ou un déploiement raté, pas la perte du VPS. Pour une copie ailleurs (à faire à la main, aucune automatisation : elle demande une destination et des identifiants), depuis la session `ubuntu` : `sudo install -o ubuntu -g ubuntu -m 600 /home/review/review-agent/backups/<fichier>.sql.gz ~/`, puis depuis ton poste : `scp ubuntu@<ip>:<fichier>.sql.gz .` (le dossier `backups/` n'est lisible que par `review`, qui n'a pas d'accès SSH). La clé `SECRETS_MASTER_KEY` n'est **pas** dans ces fichiers : sans elle, les jetons enregistrés restent illisibles après une restauration (section 4).
- **Restauration** : `COMPOSE_FILE=docker-compose.hote.yml APP_UNIT=review-agent bash scripts/restore.sh backups/<fichier>.sql.gz --yes` (`APP_UNIT` : le service systemd arrêté puis relancé à la place du service compose `app`). Destructif : essaie-la une fois avant d'en avoir besoin.
- **Import de ta base locale** (section 5 bis) : `systemctl --user stop review-agent`, `node --env-file=.env dist/cli/importSqlite.js ~/review-agent.sqlite`, `systemctl --user start review-agent`.
- **Mise à jour par script (préparé le 2026-11-27, jamais essayé sur le VPS)** : `bash scripts/deploy.sh --dry-run` montre ce qui serait fait sans rien changer (commits reçus, fichiers modifiés, étapes), puis `bash scripts/deploy.sh` l'exécute :
  1. refus si un conteneur `ra-agent-*` tourne (`--force` pour passer outre : le redémarrage annule les agents), si le dépôt du VPS a des fichiers suivis modifiés, ou si un autre déploiement est en cours ;
  2. sauvegarde (`scripts/backup.sh`, qui s'arrête en erreur si le fichier est vide) ;
  3. `git merge --ff-only` du commit distant, puis seulement ce que les fichiers changés exigent : `npm ci` si `package.json` ou le verrou a changé, reconstruction de l'image si `Dockerfile.agent` a changé (paquets : variable `AGENT_PACKAGES`, défaut ceux de l'étape 7), recopie de l'unité systemd si elle a changé **et** que ta copie est restée celle du dépôt (sinon un avertissement, jamais d'écrasement) ;
  4. `tsc`, redémarrage, attente de `app.started` dans le journal (`START_TIMEOUT`, 60 secondes par défaut) ;
  5. si la compilation ou le démarrage échoue : `git reset --hard` sur l'ancien commit, recompilation, nouveau redémarrage, et la fin du journal affichée. Le dépôt du VPS n'a aucun commit local, donc rien n'est perdu.
  Il ne lit ni ne modifie jamais le `.env` : il rappelle seulement de relire le diff si `src/config.ts` a changé (une variable est peut-être à ajouter à la main). Un retour arrière ne défait pas une migration de base déjà jouée : c'est pour cela que la sauvegarde passe en premier.
- **Mise à jour à la main** (ce que fait le script) : sauvegarde, `git pull`, `npm ci`, `npx tsc -p tsconfig.build.json`, reconstruire l'image des agents si `Dockerfile.agent` ou la version de la CLI a changé (commande de l'étape 7), `systemctl --user restart review-agent`. Ne jamais sauter `tsc` : le `git pull` met à jour le dashboard (`public/`) mais pas le serveur compilé (`dist/`). Le redémarrage annule les agents en cours (arrêt au bout de 30 secondes au plus) : vérifier d'abord dans l'onglet Agent dev qu'aucune tâche ne tourne. Les migrations de la base s'appliquent au démarrage et un retour en arrière du code ne les défait pas.

**Mémoire** : base 0,5 Go, outil 1 Go au plus (`MemoryMax` de l'unité), un agent 1,5 Go (`AGENT_MEMORY`, un seul à la fois), soit environ 3 Go sur les 5 Go libres du VPS. Ne monte pas `MAX_CONCURRENT_AGENTS` sans regarder `free -h`.

**Ce que ça protège, et ce que ça ne protège pas**
- Une compromission de l'outil donne les droits de `review` : son `.env`, ses données, son Docker. Ni root, ni rag-saas (autre démon, autres fichiers), tant que `review` n'a pas de `sudo` et n'est pas dans le groupe `docker` du Docker avec root.
- Un agent ne voit que son dossier de travail et ne reçoit que les identifiants Claude de la personne (clé API ou jeton d'abonnement). Ils restent lisibles par son propre agent et le réseau n'est pas filtré (D7) : une clé par personne avec un budget plafonné chez Anthropic limite le risque.
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
- [ ] **Connexion par email** (facultative) : un compte Resend, un **domaine vérifié** chez eux (enregistrements SPF et DKIM dans le DNS), puis `RESEND_API_KEY` et `MAIL_FROM` dans le `.env` (jamais dans un fichier versionné). `PUBLIC_URL` est obligatoire (les liens des emails pointent dessus). `AUTH_OWNER` peut être ton adresse email. `AUTH_SIGNUP=invite` (défaut) : on entre sur invitation ; `open` : n'importe qui peut créer un compte. Tester un envoi réel avant d'ouvrir (docs/a-tester.md, section 11 quinquies). Sans ces variables, rien ne change : les forges seules connectent.
- [ ] Des limites par personne sont réglées avant d'inviter (Paramètres > Modèles : budget du mois en mode clé API, agents par jour dans les deux modes), surtout sur un abonnement partagé.
- [ ] **Les agents tournent en conteneurs (section 11), obligatoire dès qu'il y a des comptes** : `review` n'est ni dans `sudo` ni dans le groupe `docker`, `docker info` contient `name=rootless`, le test de plafond mémoire de l'étape 4 affiche bien `67108864`, et `grep AGENT_RUNTIME .env` ne montre pas `host` (l'outil refuse de toute façon de démarrer avec des comptes).
- [ ] Chaque personne qui utilise l'abonnement a enregistré **son** jeton (`claude setup-token`, Paramètres > Connexion) : Paramètres > Agents dans des conteneurs > Tester les conteneurs affiche « Connexion à Claude : ok ». Sans jeton, ses tâches sont refusées avec la marche à suivre.
