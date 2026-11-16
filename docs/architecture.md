# Architecture

Ce document décrit l'outil, pas le planning : pour le planning, voir `docs/roadmap.md`.

## Objectif

Un dashboard local qui pilote Claude Code sur le travail GitLab quotidien :
1. **Tickets** : voir mes tickets assignés, rangés par statut du workflow.
2. **Agent dev** : déléguer un ticket à un agent. Il crée la branche et code, puis l'outil pousse la branche et ouvre une MR Draft que je contrôle avant de la passer en Ready.
3. **Reviews** : faire la première passe de review des MR de mes collègues où je suis reviewer, et ne me remonter que ce qui mérite mon analyse.
4. Plus tard : le support Planio (diagnostic, brouillon de réponse, brouillon d'issue).

Outil **local** : il tourne dans la WSL de chaque utilisateur, avec son token GitLab et son abonnement Claude. Il n'est pas déployé.

## Vue d'ensemble

```
                     ┌──────────────────────── review-agent (WSL, Node 24) ─────────────────────────┐
 GitLab API ◄─poll── │ triggers/reviewPoller ─► reviews ─► file review ─► review/pipeline  (lecture) │
 (self-managed)     │                                                                              │
            ◄─────── │ onglet Tickets ─► « Traiter » ─► dev_tasks ─► file dev ─► dev/pipeline        │
                     │                                                                              │
                     │  review : worktree au sha de la MR ─► claude -p (Read/Grep/Glob) ─► décision │
                     │  dev    : branche du ticket ─► claude -p (lecture/écriture + tests autorisés) │
                     │           ─► contrôles ─► commit ─► push de CETTE branche ─► MR Draft         │
                     │                                                                              │
                     │  settings (base) : workflow, conventions, projets, modèles, mode d'action  │
 Navigateur ◄─http── │ server/app (Fastify, 127.0.0.1:4321) + public/index.html (4 onglets)         │
                     └──────────────────────────────────────────────────────────────────────────────┘
```

## Configuration : .env ou dashboard

| Où | Quoi | Pourquoi |
|---|---|---|
| `.env` | Token et URL GitLab, nom d'utilisateur, chemin de la CLI Claude, port, dossier de données | Secrets et réglages propres à la machine |
| Dashboard (table `settings`) | Mode d'action, modèles et effort, règles de décision, labels du workflow, conventions de nommage | Réglables sans toucher au code ni redémarrer |
| Dashboard (table `projects`) | Par projet : agent autorisé, branche de départ, branche cible, commandes autorisées, consignes | Chaque projet a ses branches (`global`, intermédiaire, `master`...) |

Les réglages sont validés par zod (`src/settings/schema.ts`) côté serveur. Le plafond de modèle (Sonnet 5.5, effort `high`) est donc imposé même si on contourne l'interface. Un réglage ajouté dans une version ultérieure prend sa valeur par défaut sans casser la base existante (`mergeWithDefaults`).

Un collègue qui veut l'outil : `git clone`, `npm install`, `.env` avec son token, puis la configuration dans le dashboard (voir le README).

## Agent dev : déroulé d'une tâche

`src/dev/pipeline.ts`, déclenché par le bouton « Traiter avec l'agent » de l'onglet Tickets :

1. **Vérifications** : le projet doit être configuré et activé, et aucun autre agent ne doit travailler sur ce ticket.
2. **Branche** : son nom vient du template (`feature/{iid}-{slug}` par défaut).
   - Elle passe par `assertBranchAllowed` (`src/dev/guard.ts`), qui exige un nom valide contenant le numéro du ticket. Ce ne peut être ni une branche partagée, ni la base, ni la cible, ni une branche protégée GitLab.
   - Elle ne doit pas déjà exister sur GitLab.
   - Elle est créée depuis la branche de départ à jour, dans un worktree dédié (`data/repos/dev/`).
3. **Label** (optionnel) : posé sur le ticket au démarrage (ex. `Statut::En cours`).
4. **Agent** (`src/dev/engine.ts`) : `claude -p` en `stream-json`. Le journal du dashboard est alimenté en direct.
   - Il reçoit le ticket, sa discussion, le CLAUDE.md du dépôt et tes consignes éventuelles.
   - Il produit un rapport structuré : `done` ou `blocked`, résumé, message de commit, tests, points à vérifier, questions.
5. **Si `blocked`** (ticket trop ambigu) : rien n'est poussé, les questions s'affichent dans le dashboard.
6. **Contrôles avant push** :
   - si l'agent a committé lui-même malgré l'interdiction, ses commits sont repliés (`reset --soft`) dans le commit de l'outil ;
   - au moins un fichier doit être modifié ;
   - aucun fichier de secrets (`.env`, clés) ne doit l'être, sinon le push est refusé ;
   - contrôle des fichiers (`src/dev/fileGuard.ts`) : pas de chemin absolu, avec `..` ou dans `.git`, pas de lien symbolique sortant du dépôt, taille limitée, et encodage préservé (un fichier ISO-8859-1 réécrit en UTF-8, ou contenant U+FFFD, est refusé).
7. **Commit** au format configuré, avec l'identité GitLab de l'utilisateur. Le sujet proposé par l'agent est nettoyé : une ligne, sans trailer `Co-Authored-By`.
8. **Push** : `git push origin HEAD:refs/heads/<branche>`, sans `--force`, après une seconde vérification de la branche.
9. **MR** : toujours en **Draft** (`ensureDraftTitle`, quel que soit le template), vers la branche cible du projet, assignée à l'utilisateur. La description reprend le template et le rapport de l'agent, et signale les fichiers sensibles modifiés (CI, Docker, dépendances).

Le passage en Ready se fait par la personne (selon le workflow de l'équipe, il peut faire passer le ticket en validation technique) : soit chez la forge, soit depuis l'outil avec la fusion de la pièce (voir ci-dessous).

10. **Relecture et fusion de la pièce** (`src/dev/merge.ts`, `src/dev/pieceRoutes.ts`) : depuis la forge (fenêtre « La pièce forgée ») ou la page de la tâche, la personne fait relire la MR par le Gardien (l'agent de review, en lecture seule, qui ne publie rien sur sa propre MR), puis, si la review est OK sur le commit actuel et la CI sans rouge, la fusionne dans la branche cible du projet. `mergeReadiness` est une fonction pure rejouée par le serveur à chaque demande : MR ouverte, branche source = branche de la tâche, cible = cible du projet, review terminée sans point à analyser sur le commit de tête, CI ni rouge ni en cours (et lisible). La MR est sortie du brouillon puis fusionnée avec le `sha` relu (la forge refuse si la tête a bougé). Les deux écritures sont tracées au journal d'audit (`change_request_ready`, `change_request_merge`). **L'outil ne déploie rien** : la mise en ligne est celle du projet (CI/CD, hébergement) ou, pour l'outil lui-même, `git pull` puis `docker compose up -d --build`.

Le worktree est **conservé** après la tâche : on peut reprendre la conversation avec `claude --resume <session>` depuis son dossier (commande affichée dans le dashboard), puis le nettoyer d'un clic.

### Reprise d'une MR existante

Bouton « Reprendre avec des consignes » sur une tâche terminée liée à une MR. Une nouvelle tâche (`mode = followup`, `parent_id` = tâche d'origine) hérite de la branche et de la MR :

1. **Vérifications** : consignes obligatoires, MR toujours ouverte et partant de la même branche, `assertBranchAllowed` comme au premier passage.
2. **Branche** : récupérée **telle qu'elle est sur GitLab** (`checkoutExistingBranch`), commits poussés à la main compris. Refus si l'ancien worktree contient des modifications non committées ou des commits non poussés, pour ne jamais écraser du travail local.
3. **Agent** : reçoit tes consignes, le ticket, le rapport de la tâche d'origine, les commentaires de la MR (fichier, ligne, résolu ou non) et la commande pour voir tout le diff de la MR.
4. **Mêmes contrôles avant push** qu'au premier passage, puis **nouveau commit** poussé en fast-forward (jamais de `--force`) et commentaire sur la MR avec les consignes et le rapport. Statut `mr_updated`. Bloqué = rien n'est poussé.

Dans les commandes autorisées d'un projet, `{worktree}` est remplacé par le dossier de travail de l'agent : c'est lui qu'il faut monter dans un conteneur pour tester son code.

## Review : déroulé

1. **Détection** (`src/triggers/reviewPoller.ts`) : toutes les `POLL_INTERVAL_SEC` secondes, le poller liste les MR ouvertes, hors draft, où l'utilisateur est reviewer, et dont il n'est pas l'auteur. Chaque couple (MR, sha de tête) n'est traité qu'une fois : un nouveau push crée une nouvelle review.
2. **Contexte** (`src/review/context.ts`) : diffs filtrés (lockfiles, assets compilés, images, `.env`), tickets liés, commits et statuts CI. Les textes rédigés par des humains sont balisés `<contenu_externe>`.
3. **Checkout** (`src/review/workspace.ts`) : `refs/merge-requests/<iid>/head`, puis un worktree jetable au sha exact.
4. **Agent** (`src/review/engine.ts`) : `claude -p` en lecture seule, sortie contrainte par `--json-schema`.
5. **Décision** (`src/review/decision.ts`) : c'est le **code** qui décide, pas le modèle. Une review n'est `auto_ok` qu'avec des suggestions uniquement et aucun garde-fou déclenché.
6. **Action** selon le mode réglé dans le dashboard : `shadow` (rien), `comment`, ou `auto` (commentaire et approbation liée au sha). Les `needs_human` ne partent jamais seules.

## Modules

| Fichier | Rôle |
|---|---|
| `src/index.ts` | Point d'entrée : config, BDD, deux files (review, dev), poller, serveur |
| `src/config.ts` | Lecture du `.env` (secrets et machine uniquement) |
| `src/agent/dockerRunner.ts` | Option : l'agent tourne dans un conteneur jetable qui ne monte que son dossier de travail (`AGENT_RUNTIME=docker`, mode clé API) |
| `src/agent/imageName.ts` | Noms d'images d'agents et liste autorisée (`AGENT_IMAGE`, `AGENT_IMAGES`) : l'image par défaut ou celle choisie par un projet |
| `src/agent/dockerDiagnostic.ts` | Diagnostic des conteneurs d'agents (bouton « Tester les conteneurs » des Paramètres) : lance un conteneur d'essai aux options d'une vraie tâche et contrôle Docker, image, écriture, isolation, plafonds, CLI |
| `src/connectors/audited.ts`, `src/db/audit.ts` | Journal d'audit : chaque écriture sur une forge (label, MR, commentaire, approbation, branche poussée) est inscrite au nom de la personne, réussie ou non |
| `Dockerfile`, `docker-compose.yml`, `scripts/` | Déploiement serveur (application et PostgreSQL), sauvegarde et restauration : `docs/deploiement.md` |
| `Dockerfile.agent`, `docker-compose.hote.yml`, `deploy/review-agent.service` | Variante : l'outil sur la machine sous un utilisateur dédié avec Docker sans root, base seule dans Docker, agents en conteneurs : `docs/deploiement.md`, section 11 |
| `src/tenants/` | Exécution par personne et par espace : connexions aux forges de son coffre, dépôts liés à son espace, files et pollers (`manager.ts`), limite commune d'agents simultanés (`limiter.ts`). Le serveur redirige chaque requête vers l'exécution de la personne connectée |
| `src/auth/` | Connexion par compte de forge : OAuth avec PKCE (`oauth.ts`), sessions (`sessions.ts`), règles d'accès (`login.ts`), routes et contrôle d'accès du serveur (`routes.ts`). Dormante sans application OAuth configurée |
| `src/secrets/` | Coffre à secrets : chiffrement AES-256-GCM (`crypto.ts`), clé maître hors base (`masterKey.ts`), table `secrets` par espace et utilisateur (`store.ts`), jeton GitHub et clé API saisis dans le dashboard (`vault.ts`). `src/logger.ts` masque dans les journaux toute valeur déclarée secrète |
| `src/settings/` | Schéma, valeurs par défaut et stockage des réglages et projets |
| `src/db/` | Accès à la base indépendant du moteur : interface `Db` asynchrone, adaptateurs SQLite (`node:sqlite`, local) et PostgreSQL (`pg`, serveur), migrations communes ; dépôts `reviews`, `devTasks` et `costs` liés à un espace (aucune requête ne sort de son espace), et `accounts` (utilisateurs, espaces, appartenances : un espace garde un admin, un espace personnel n'a qu'un membre) |
| `src/connectors/` | Interface `ForgeConnector` et vocabulaire neutre (ticket, demande de fusion, commentaire...). `gitlab.ts` et `github.ts` : un connecteur par forge, les seuls à connaître l'API et les types de leur forge. `registry.ts` : registre des forges configurées (connecteur, copies locales de dépôts, identité de l'utilisateur), retrouvées par la colonne « source ». Les pipelines, le poller, le serveur et la CLI n'utilisent que l'interface |
| `src/gitlab/client.ts` | Client API GitLab v4 (fetch natif, pagination), utilisé par le connecteur GitLab uniquement |
| `src/github/` | Client REST GitHub (fetch natif, pagination par `Link` limitée au même serveur) et types de ses réponses, utilisés par le connecteur GitHub uniquement |
| `src/testing/` | Faux connecteur et environnement de test (dépôt git local, base temporaire). Réservé aux tests |
| `src/agent/` | Exécuteur d'agent : interface `AgentRunner`, `CliRunner` (CLI Claude Code sur l'abonnement), événements du journal. Les protections d'isolation (`--safe-mode`, aucun MCP, `dontAsk`) y sont écrites, hors de portée des appelants |
| `src/budget.ts`, `src/db/costs.ts` | Consommation des agents par mois, projet et type de tâche. Budget mensuel appliqué en mode clé API : une review ou une tâche de dev n'est pas lancée une fois le budget atteint |
| `src/redact/` | Caviardage des données personnelles avant tout envoi au modèle : détecteurs à validation, repères stables, mode strict. Pas encore branché (réservé au support client) |
| `src/claude/process.ts` | Lancement de la CLI : stdin, streaming ligne par ligne, délai maximum, annulation, environnement sans clé API |
| `src/claude/status.ts` | Sonde de l'état de connexion de la CLI (`claude auth status`), mise en mémoire 30 s : pastille « connecté » des Paramètres et quête du jeu |
| `src/terminal/` | Terminal Claude du navigateur, pour connecter l'abonnement sans SSH : `session.ts` (une session par personne, sortie gardée, expiration), `launch.ts` (la CLI `claude` seule dans un pseudo-terminal fourni par l'outil `script`, environnement filtré des agents, jamais un shell), `routes.ts` (flux de sortie en Server-Sent Events, saisie par requêtes, réservé au propriétaire, refusé derrière un proxy sans connexion par compte). Côté navigateur : xterm.js, servi par l'outil (`public/vendor/xterm/`, version figée) |
| `src/game/` | La forge, couche de jeu déduite de l'activité réelle sans aucune table : `hero.ts` (XP, niveaux, quêtes de premiers pas, hauts faits), `workers.ts` (forgerons de l'atelier : un par agent actif, avec ce qu'il dit d'après sa dernière étape), `armory.ts` (projets = armes, tâches terminées = pièces forgées, notes et raretés), `progress.ts` (série de jours, missions du jour et de la semaine, maîtrises à paliers, rangs de prestige : de quoi donner envie de revenir) |
| `src/rooms/` | Salles du monde de la forge, décrites par des fichiers de données (`public/rooms/*.json`) : `catalog.ts` (objets, thèmes, limites), `schema.ts` (forme, grille, jouabilité), `registry.ts` (chargement et portes), `routes.ts` (`GET /api/rooms`). Format : `docs/salles.md` |
| `src/scribe/` | Le Scribe : un agent sans aucun outil rédige un brouillon de ticket ou de projet (`engine.ts`, `prompt.ts`, `schema.ts`), `clean.ts` valide ce qui peut partir chez la forge, `errors.ts` traduit un refus en droit à ajouter au jeton, `limiter.ts` plafonne par heure, `routes.ts` expose `/api/scribe/*` et `/api/forge/{tickets,namespaces}`. L'écriture passe par le connecteur (donc par l'audit) et seulement après la validation de la personne |
| `public/forge/` | Monde 2D de la page « La forge », chargé à la demande : pixel art dessiné par le code (`sprites.js`), sons synthétisés désactivés par défaut (`audio.js`), fenêtres réutilisant les vrais formulaires (`popups.js`), fenêtre du Scribe (`scribe.js`), moteur (`game.js`). La progression du jeu reste dans le navigateur (`localStorage`) |
| `src/review/*` | Review : contexte, worktree git (partagé avec l'agent dev), moteur, décision, mise en forme, orchestration |
| `src/dev/*` | Agent dev : garde-fous, templates, contexte, moteur, orchestration |
| `src/server/app.ts` | API JSON et service du dashboard |
| `src/cli/` | `reviewOnce` (review manuelle par URL de MR) |
| `prompts/` | Prompts de base par défaut (`*-system.md`, remplaçables dans le dashboard) et garde-fous (`*-guardrails.md`, toujours ajoutés en dernier). Assemblage dans `src/prompts.ts` : base < consignes perso < consignes du projet < garde-fous |
| `scripts/` | Tests réels de la CLI : `smoke-review.ts` (review et isolation), `smoke-dev.ts` (agent dev) |

## Données

Tout se trouve dans `DATA_DIR` (par défaut `./data`, ignoré par git) :
- **Base de données** : SQLite dans `DATA_DIR` par défaut (rien à installer), ou PostgreSQL si `DATABASE_URL` est défini dans le `.env` (mode serveur). Mêmes tables dans les deux cas :
  - `reviews` et `actions` : reviews et piste d'audit de ce que l'outil a fait en ton nom ;
  - `dev_tasks` et `dev_task_events` : tâches de l'agent et journal ;
  - `settings` et `projects` : réglages du dashboard.
- **Logs** JSON lines quotidiens.
- **`repos/`** : clones bare, worktrees de review (jetables) et de dev (conservés).

## Choix structurants

**Outil générique, configuré par utilisateur.** Il agit au nom de son utilisateur (son token, son abonnement). Rien de propre à une entreprise n'est écrit dans le code : URL et token dans le `.env`, labels, projets, conventions et consignes des agents dans les réglages du dashboard.

**Pas de serveur MCP GitLab.** Un serveur officiel existe (`/api/v4/mcp`), mais il est en beta, réservé aux instances récentes et conditionné à Duo. Surtout, il élargirait ce que l'agent peut faire sur GitLab. Ici, l'agent ne parle jamais à GitLab : c'est l'outil qui lit les tickets, pousse et ouvre la MR, avec ses propres contrôles.

**Polling plutôt que webhook.** La WSL n'est pas joignable depuis GitLab, et le webhook projet peut déjà être utilisé par un autre outil.

**La CLI Claude Code dans les deux modes de connexion.** `claude -p` est l'usage headless documenté avec un abonnement ; avec `ANTHROPIC_API_KEY` dans son environnement, la même CLI s'authentifie par clé API (facturation à l'usage). Le choix est un réglage du dashboard (Paramètres > Modèles) : abonnement par défaut, clé API en option, avec un budget mensuel. Dans les deux cas les outils, les permissions et les protections d'isolation sont identiques, et le plafond de modèle est imposé dans le code. Un déploiement à l'équipe sur serveur utiliserait le mode clé API (roadmap-plateforme, lots C et D) ; le SDK reste une option si une bibliothèque devient nécessaire.

**Décision et actions dans le code, pas dans le modèle.** Le modèle propose (review, code, rapport). Le code décide d'agir (approuver, pousser, créer la MR) selon des règles lisibles et testées.

## Sécurité

**Les deux agents :**
- **`--safe-mode`** : CLAUDE.md, hooks, plugins, skills et MCP du dépôt sont ignorés. Sinon, un dépôt ou une MR pourrait exécuter des commandes sur la machine via un `.claude/settings.json` piégé. Vérifié par `scripts/smoke-review.ts`.
- **Mode `dontAsk`** : ce qui n'est pas explicitement autorisé est refusé, sans question. Aucun accès réseau (`WebFetch`, `WebSearch`, `curl`, `wget`, `ssh` interdits).
- **Contenus externes balisés** (ticket, discussion, description de MR) : ce sont des spécifications ou des données, jamais des ordres. Le prompt dev liste ce qu'un ticket ne peut pas demander : secrets, CI, réseau, autres dépôts, désactivation de sécurité.
- **Clé API écartée** de l'environnement de la CLI : c'est toujours l'abonnement qui sert.

**Agent dev, en plus :**
- Il peut lire et écrire les fichiers du worktree, consulter git en lecture, et lancer **uniquement** les commandes configurées pour le projet.
- `git commit`, `push`, `reset`, `checkout`, `branch`, `remote` et `config` sont explicitement interdits.
- Les garde-fous de branche (`src/dev/guard.ts`, testés) et le flux git (`workspace.test.ts`, test d'intégration contre un dépôt distant local) garantissent qu'**aucune autre branche que celle du ticket** ne peut être poussée.
- Les fichiers de secrets bloquent le push. Les fichiers de CI, Docker et dépendances sont signalés en tête de MR.
- **Vérifié en réel le 2026-11-04** (`scripts/smoke-dev.ts`) :
  - le fichier a été modifié et la commande autorisée exécutée ;
  - une commande non autorisée a été refusée ;
  - la tentative de commit de l'agent a été refusée, et elle aurait de toute façon été repliée.

**Review :** agent en lecture seule, approbation liée au sha reviewé.

**Dashboard :** il n'écoute qu'en local (`127.0.0.1`). Un header anti-CSRF est obligatoire sur toutes les actions : sans lui, un site ouvert dans le navigateur pourrait lancer l'agent ou approuver une MR via `localhost`. Tout contenu externe est échappé à l'affichage.

**Token GitLab** : injecté par variable d'environnement à chaque commande git, jamais écrit dans `.git/config` ni dans une URL.

## Points ouverts (décisions à prendre, pas techniques)

- **Abonnement perso et code client** : l'entraînement sur les données est désactivé dans les paramètres claude.ai. La question de principe disparaît avec une clé entreprise (item 25).
- **Transparence** : les commentaires de review et les MR de l'agent portent une mention IA. À aligner avec l'équipe avant les modes `comment` ou `auto`.
