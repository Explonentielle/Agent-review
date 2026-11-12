# Roadmap de la plateforme

Plan d'exécution de `docs/vision-plateforme.md` (architecture, décisions) et `docs/parcours-utilisateur.md` (parcours). La roadmap générale de l'outil reste `docs/roadmap.md` (item 36 y renvoie ici).

## Comment lire ce document

- **Efforts** (ordres de grandeur pour un développeur assisté, à réviser après le premier lot) : **S** ≤ 1 jour, **M** 2 à 4 jours, **L** 1 à 2 semaines, **XL** plus de 2 semaines.
- **Statuts** : ⬜ à faire, 🟦 en cours, ✅ fait, ⏸ bloqué (raison indiquée).
- **Définition de « fait »** pour toute tâche : typecheck et tests au vert, test sur la logique de sécurité concernée, aucun garde-fou affaibli (CLAUDE.md), documentation à jour (`architecture.md` si le flux change), et ce qui n'a pas été testé en réel est écrit. Mode ombre par défaut pour toute action externe.
- **Méthode** : les tâches marquées « décision requise » passent par une clarification avant le code (CLAUDE.md, méthode de travail).

## Jalons

| Jalon | Contenu | Ce que l'utilisateur peut faire |
|---|---|---|
| **J1** | Lot A | Outil local avec moteur d'agent abstrait, garde-fous de fichiers renforcés, caviardage prêt, interface de connecteur. Clé API possible en local. |
| **J2** | Lot B | GitLab et GitHub dans le même dashboard. |
| **J3** | Lot C | Plateforme sur serveur, plusieurs utilisateurs, comptes OAuth, agents en clé API. |
| **J4** | Lot D | Un conteneur par utilisateur, patch seul hors du conteneur, abonnement via `/login` dans le conteneur. |
| **J5** | Lot E | Support client assisté, données caviardées, validation humaine. |
| **J6** | Lots F et G | Tickets internes avec Gitea, isolation renforcée, supervision, sauvegardes. |

**Chemin critique** : A1 → A3 → C → D → E. Branches indépendantes : A5 → B ; A4 → E3 ; A2 → D5.

## Vue d'ensemble

| ID | Lot | Tâche | Effort | Dépend de | Statut |
|---|---|---|---|---|---|
| A1 | Socle | Interface `AgentRunner` et `CliRunner` (comportement inchangé) | M | | ✅ 2026-11-09 |
| A2 | Socle | Garde-fous de fichiers avant push : encodage, chemins, liens, taille | M | | ✅ 2026-11-09 |
| A3 | Socle | Connexion par clé API : la CLI avec `ANTHROPIC_API_KEY` (remplace le SDK) et réglage dans le dashboard | M | A1 | ✅ 2026-11-09, à valider avec une vraie clé Anthropic |
| A4 | Socle | Module de caviardage des données personnelles | M | | ✅ 2026-11-09 |
| A5 | Socle | Interface de connecteur de tickets, adaptateur GitLab, pipelines migrés | L | | ✅ 2026-11-09 |
| A6 | Socle | Coûts par projet et par type de tâche, budget en mode API | S | A3 | ✅ 2026-11-09, par utilisateur avec le lot C |
| A7 | Socle | Exécuteur multi-fournisseur (OpenAI...) : boucle d'agent et outils propres | XL | A1 | 💡 idée, non planifiée |
| B1 | GitHub | Client REST GitHub (tickets, PR, branches, vérifications, reviews) | M | | ✅ 2026-11-10, à valider sur un vrai dépôt GitHub |
| B2 | GitHub | Connecteur GitHub sur l'interface A5 | M | A5, B1 | ✅ 2026-11-10, à valider sur un vrai dépôt GitHub |
| B3 | GitHub | Correspondance des statuts (labels, projets GitHub) | S | B2 | ✅ 2026-11-10 pour les labels (portée émulée) ; « projets » GitHub non faits |
| B4 | GitHub | Review de PR et création de PR Draft | M | B2 | ✅ 2026-11-10, à valider sur un vrai dépôt GitHub |
| B5 | GitHub | Tests sur réponses enregistrées | S | B2 | ✅ 2026-11-10 sur des réponses construites d'après la documentation, à enregistrer sur un vrai compte |
| B6 | GitHub | Écran Connecteurs : choisir la forge par projet | M | B2 | ✅ 2026-11-10, à essayer dans un navigateur |
| C1a | Serveur | Couche de données asynchrone : SQLite (local) et PostgreSQL (serveur), migrations communes | L | | ✅ 2026-11-09 |
| C1b | Serveur | Modèle multi-espaces : utilisateurs, espaces, appartenances (la colonne « source » est faite avec le lot B) | M | C1a | ✅ 2026-11-10 pour le modèle ; le rattachement des données à un espace est en C4 |
| C2 | Serveur | Connexion OAuth GitLab et GitHub | M | C1b | ✅ 2026-11-10 pour le propriétaire seul ; l'ouverture à d'autres personnes attend C8 |
| C3 | Serveur | Secrets chiffrés (AES-256-GCM, clé maître hors base) | M | C1b | ✅ 2026-11-10 pour le jeton GitHub et la clé API Anthropic ; jetons GitLab et Planio non gérés |
| C4 | Serveur | Isolation des données par espace, tests d'étanchéité | L | C1b | ✅ 2026-11-10 pour la couche de données ; l'exécution multi-espaces vient avec C2 et C8 |
| C5 | Serveur | Réglages par portée : équipe, utilisateur, projet | M | C4 | ⬜ |
| C6 | Serveur | Journal d'audit des écritures sur les forges | M | C4 | ✅ 2026-11-11 |
| C7 | Serveur | Quotas et budgets par utilisateur | M | A6, C4 | ⬜ |
| C8 | Serveur | File de tâches par utilisateur, limites de concurrence | M | C4 | ✅ 2026-11-10 (files par personne, limite commune) ; priorité équitable et éviction des inactifs non faites |
| C9 | Serveur | Déploiement : image de la plateforme, TLS, sauvegardes | L | C1a | 🟡 2026-11-10 préparé (image, compose, sauvegardes), jamais construit ni lancé ; TLS non fait |
| D1 | Environnements | Modèle d'environnement et lecture de `devcontainer.json` | M | C4 | ⬜ |
| D2 | Environnements | Orchestrateur Docker : rootless, limites, volumes, arrêt à l'inactivité | L | D1 | ⬜ |
| D3 | Environnements | Génération du Dockerfile par l'agent (droits réduits) | M | D1, A1 | ⬜ |
| D4 | Environnements | Vérification de l'image : bac à sable, versions, scan, test à blanc | L | D2 | ⬜ |
| D5 | Environnements | Patch seul : sortie du conteneur et application contrôlée | L | A2, D2 | ⬜ |
| D6 | Environnements | Démon agent dans le conteneur (tâche, événements, annulation) | L | A1, D2 | ⬜ |
| D7 | Environnements | Réseau : liste blanche et proxy de paquets | M | D2 | ⬜ |
| D8 | Environnements | Terminal web authentifié et `/login` Claude dans le conteneur | M | D2 | ⬜ |
| D9 | Environnements | Modèles d'environnement d'équipe | S | D4 | ⬜ |
| D10 | Environnements | Secret de construction pour paquets privés | S | D4 | ⬜ |
| E1 | Support | Connecteur Planio (client existant à brancher) | M | A5 | ⬜ |
| E2 | Support | Ingestion et tri des demandes | M | E1 | ⬜ |
| E3 | Support | Caviardage intégré, mode strict, écran « à relire » | M | A4, E2 | ⬜ |
| E4 | Support | Diagnostic en lecture seule | M | E3, D6 | ⬜ |
| E5 | Support | Brouillon en note privée, écran support, réidentification | L | E4 | ⬜ |
| E6 | Support | Brouillon de ticket de dev, validation, publication | M | E5 | ⬜ |
| E7 | Support | Taux d'accord par catégorie et règles d'assouplissement | M | E5 | ⬜ |
| E8 | Support | Jira Service Management et email | L | E1 | ⬜ |
| E9 | Support | AIPD et avis du DPO | non technique | | ⏸ bloquant avant données réelles |
| E10 | Support | Suppression à la demande et purge automatique | M | E3 | ⬜ |
| F1 | Interne | Tickets internes : modèle et écrans | M | A5 | ⬜ |
| F2 | Interne | Gitea embarqué : déploiement, comptes, projets | L | C9 | ⬜ |
| F3 | Interne | Connecteur Gitea | M | A5, F2 | ⬜ |
| F4 | Interne | MR liée à un ticket interne | M | F1, F3 | ⬜ |
| G1 | Industrialisation | Isolation renforcée (gVisor ou Sysbox) | L | D2 | ⬜ |
| G2 | Industrialisation | Supervision et alertes | M | C9 | ⬜ |
| G3 | Industrialisation | Sauvegardes et restauration testées | M | C9 | ⬜ |
| G4 | Industrialisation | Évaluation de Coder et de Kubernetes | M | D2 | ⬜ |
| G5 | Industrialisation | Notifications email, Slack, Teams | M | C4 | ⬜ |
| G6 | Industrialisation | Export des données et suppression de compte | M | C4 | ⬜ |

## Lot A : socle local (jalon J1)

Aucune infrastructure serveur : tout se développe et se teste sur l'outil actuel, sans changer son comportement visible.

| ID | Critères d'acceptation | Tests |
|---|---|---|
| **A1** | Les deux agents (review, dev) passent par une interface `AgentRunner`. `CliRunner` construit exactement les mêmes arguments que le code actuel, conserve l'annulation et le délai maximum. Aucune modification des réglages ni de la base. | Faux binaire `claude` qui enregistre ses arguments et renvoie un résultat prédéfini : arguments identiques pour la review et pour le dev, résultat structuré lu, erreur propagée, annulation. Les 37 tests existants restent verts. |
| **A2** | Avant le commit, l'outil refuse : un fichier dont l'encodage d'origine était ISO-8859-1 et qui ne l'est plus, tout ajout du caractère de remplacement U+FFFD, un chemin sous `.git/`, absolu ou contenant `..`, un lien symbolique sortant du dépôt, un fichier au-dessus d'une taille maximale. Le message dit quel fichier et pourquoi. Sert de base au contrôle des patchs (D5) et traite la détection de l'item 35. | Dépôt local de test avec un fichier Latin-1 : un fichier réécrit en UTF-8 avec accents perdus est refusé, un changement sans accents est accepté. Un cas par règle. |
| **A3** | Un réglage « connexion à Claude » (abonnement ou clé API). En mode clé API, la même CLI reçoit `ANTHROPIC_API_KEY` du `.env`, avec les mêmes plafonds de modèle, les mêmes permissions et les mêmes protections d'isolation. La clé n'apparaît dans aucune erreur, aucun journal, aucune réponse de l'API. | Faux binaire qui enregistre l'environnement reçu : en abonnement aucune clé, en mode clé API seulement celle du `.env`. Masquage dans les erreurs et le journal. Un essai réel quand une clé Anthropic est disponible. |
| **A4** | Détecteurs : email, téléphone, IBAN (modulo 97), carte (Luhn), numéro de sécurité sociale (clé), passeport, date de naissance près d'un mot-clé, adresse, URL à jeton. Repères stables par ticket (`[EMAIL_1]`), table de correspondance séparée, réidentification, mode strict qui signale une suspicion non remplaçable. Types « conserver » configurables. | Corpus annoté de cas positifs et négatifs avec rappel et faux positifs mesurés, aller-retour caviarder puis réidentifier identique, aucun cas où une valeur réelle subsiste dans le texte caviardé. |
| **A5** | Types neutres (projet, ticket, commentaire, demande de fusion, diff, statut de vérification, utilisateur) et interface de connecteur. L'adaptateur GitLab enveloppe le client actuel. Les pipelines et le serveur n'appellent plus que l'interface. Comportement identique. | Les tests existants, plus des tests de l'adaptateur sur des réponses GitLab enregistrées. |
| **A6** | Le coût estimé est cumulé par mois, par projet et par type de tâche, et un budget mensuel bloque le lancement en mode clé API. Par utilisateur avec le lot C. | Calcul des cumuls, blocage au dépassement, aucun blocage hors mode clé API. |

**Risques** : A5 touche beaucoup de fichiers (pipelines, serveur, poller). Il se fait par petites étapes, en gardant les tests verts à chaque étape. A3 attend une clé API de test.

### Implémenté

**A1 (2026-11-09)** : `src/agent/` (`runner.ts` pour l'interface, `cliRunner.ts`, `events.ts`, `index.ts` avec `createRunner`).
- Les moteurs de review et de dev décrivent une tâche (`AgentRequest`) et appellent `runner.run()`. Les pipelines prennent un exécuteur optionnel (`deps.runner`) pour les tests, sinon `createRunner(config, settings)`.
- **Les protections d'isolation sont dans `CliRunner`, pas dans la requête** : `--safe-mode`, `--strict-mcp-config`, `dontAsk` sans invite, MCP toujours interdit. Aucun appelant ne peut les retirer.
- Écart assumé avec le critère d'origine : `--allowedTools` est maintenant passé en un argument par règle, y compris pour la review (`Read Grep Glob` au lieu de `Read,Grep,Glob`). La CLI accepte les deux formes (aide de la CLI : « comma or space-separated »), la forme séparée est celle déjà utilisée par l'agent dev.
- Tests (`src/agent/cliRunner.test.ts`) avec un faux binaire `claude` : arguments exacts de la review et du dev, entrée standard, clé API retirée de l'environnement, journal et session en direct, quatre erreurs, annulation. Vérifié qu'ils échouent si `--safe-mode` disparaît.
- **Testé en réel (2026-11-09)**, avec la vraie CLI, Haiku en effort faible :
  - `scripts/smoke-review.ts` (nouveau, passe par le vrai `CliRunner`, remplace `smoke-claude.sh` qui copiait les arguments à la main) : options acceptées, bug trouvé, hook piégé du dépôt non exécuté, 4 tours, environ 0,022 $ équivalent API ;
  - `scripts/smoke-dev.ts` : fichier corrigé, commande autorisée lancée, commande interdite bloquée, session conservée, 9 tours, environ 0,045 $.

**A2 (2026-11-09)** : `src/dev/fileGuard.ts`, appelé avant le commit dans `commitAgentWork` (premier passage et reprise).
- Refuse : chemin absolu, avec `..` ou dans un dossier `.git` ; lien symbolique absolu ou sortant du dépôt ; fichier au-delà de 5 Mo ou ensemble au-delà de 25 Mo ; caractère de remplacement U+FFFD ajouté ; fichier d'origine non UTF-8 (ex. ISO-8859-1) réécrit en UTF-8.
- Le contenu d'origine est lu en octets bruts au commit de base (`RepoWorkspace.readFileAtRef`). Les fichiers binaires sont ignorés pour l'encodage.
- Tests (`src/dev/fileGuard.test.ts`) : règles unitaires, et dépôt git réel avec un fichier ISO-8859-1 corrompu comme le fait un outil d'édition en UTF-8.
- **Limite** : le garde-fou détecte et refuse, il ne répare pas. Les limites de taille sont des constantes (`DEFAULT_FILE_LIMITS`), pas encore des réglages.

**A4 (2026-11-09)** : `src/redact/` (`detectors.ts`, `session.ts`, `redact.ts`, `index.ts`). Pur, sans dépendance, **pas encore branché au pipeline** (le support n'existe pas encore, lot E).
- `redact(texte, session, options)` remplace les données personnelles par des repères stables (`[EMAIL_1]`, `[TEL_1]`, `[NOM_1]`...), identiques dans tout un fil. `reidentify` fait l'opération inverse (insensible à la casse, repères inconnus laissés tels quels). La session s'exporte et se recharge (elle contient des données personnelles : à chiffrer, durée de vie limitée).
- **Détecte** : email (y compris obfusqué `(at)`), téléphone (national à 10 chiffres, international), IBAN (modulo 97), carte (Luhn), numéro de sécurité sociale (clé de contrôle), pièce d'identité et passeport près d'un mot-clé, date de naissance près d'un mot-clé, adresse postale (avec ou sans numéro de rue), nom après une civilité, plaque d'immatriculation, adresse IP publique et IPv6 complète, URL avec identifiants ou paramètre secret. Plus des **valeurs connues** (noms lus dans les champs du helpdesk) et des **motifs de l'équipe** avec option « conserver » (ex. numéro de dossier utile au diagnostic).
- **Mode strict** (par défaut) : si un motif sensible n'a pas pu être remplacé (suite de 9 chiffres ou plus, valeur chiffrée après « mot de passe », « passeport », « IBAN »..., IBAN mal saisi), `needsReview` est vrai et rien ne doit partir vers le modèle. Les suspicions donnent des positions, jamais les valeurs.
- Tests (`src/redact/redact.test.ts`) : corpus annoté de 37 valeurs à caviarder (aucune ne doit subsister, rappel 37/37) et 15 textes sans donnée personnelle à laisser intacts (0 faux positif), validations de clés, repères stables, aller-retour, session, mode strict. Les premiers essais ont fait apparaître un faux positif réel (adresses IP privées signalées), corrigé.
- **Limites connues, non couvertes** : noms libres sans civilité et absents des champs du helpdesk ; chiffres écrits en lettres ; IPv6 abrégée ; lien dont le jeton est dans le chemin (`/reset/9f8e7d...`) ; mot de passe sans chiffre ; numéros de téléphone étrangers sans `+` ni `00` ; dates de naissance sans mot-clé (volontaire, une date seule n'est pas une donnée personnelle) ; images et pièces jointes (non envoyées par défaut). Le corpus a été écrit par l'auteur du module : il est biaisé et doit être complété avec de vraies demandes anonymisées avant toute mise en service (E3, E9).

**A5 (2026-11-09)** : `src/connectors/` (`types.ts`, `gitlab.ts`, `index.ts`).
- **Interface `ForgeConnector`** et vocabulaire neutre : `Ticket`, `ChangeRequest` (merge request ou pull request), `Comment`, `Diff`, `Commit`, `CheckStatus`, `Project`, `Branch`, `CurrentUser` (avec l'adresse de commit déjà résolue). Les pipelines de review et de dev, le poller (renommé `src/triggers/reviewPoller.ts`), le serveur et la CLI `review:once` ne manipulent plus que ces types. Les types et le client GitLab (`src/gitlab/`) ne sont utilisés que par l'adaptateur.
- **`GitlabConnector`** enveloppe `GitlabClient` et traduit les réponses. Ce qui était propre à GitLab est passé dans le connecteur : référence git de la tête d'une MR (`refs/merge-requests/<n>/head`), reconnaissance de l'URL d'une MR, identifiants git (`oauth2`), distinction fil de review et simple commentaire. `RepoWorkspace` ne connaît plus ces détails (`checkoutChangeRequest` reçoit la référence, l'utilisateur git est un paramètre).
- **Comportement inchangé**, vérifié par les 71 tests existants (toujours verts) et par une lecture réelle de ton GitLab après le refactor : 21 tickets traduits avec les mêmes colonnes qu'avant, recherche de projets et branches OK.
- **Nouveaux tests (30)** : traduction et appels de l'adaptateur (`connectors/gitlab.test.ts`) ; **pipeline de dev de bout en bout** (7 cas : branche, commit de l'outil, push de cette seule branche, MR en brouillon, ticket flou, fichier ISO-8859-1 corrompu, secrets, branche protégée ou existante, reprise, MR fermée) et **pipeline de review** (5 cas : extraction au bon commit, décision, publication, approbation sur le commit relu, MR obsolète, modes d'action), avec un vrai dépôt git local, une vraie base SQLite temporaire, un faux exécuteur d'agent et un faux connecteur ; poller (brouillons, MR personnelles, déduplication, nouveau commit, erreur de la forge) ; routes du serveur.
- **Faux connecteur réservé aux tests** (`src/testing/`) : ce n'est pas un faux GitLab de démonstration, il n'est branché sur aucun script ni sur le dashboard.
- **Limites** : l'identifiant de projet reste un entier sans notion de forge, donc deux forges dans la même base se mélangeraient (colonne « source » à ajouter avec le lot B, avec une migration). Les routes du serveur s'appellent encore `/api/gitlab/...` et la configuration reste `config.gitlab` : à généraliser avec le lot B. La création de tickets (utile au support, E6) n'est pas dans l'interface : à ajouter quand elle servira.

**A3 et A6 (2026-11-09)** : la connexion par clé API passe par **la même CLI**, pas par le Claude Agent SDK prévu à l'origine. Raison : la CLI reconnaît `ANTHROPIC_API_KEY` (aide de la CLI : « Anthropic auth is strictly ANTHROPIC_API_KEY »), donc seul l'environnement change, et tout ce qui protège l'agent (permissions, `--safe-mode`, aucun MCP, sortie structurée) reste identique. Rien de nouveau à sécuriser, et c'est testable sans clé. Le SDK reste possible plus tard si une bibliothèque devient nécessaire.
- **Réglages** (Paramètres > Modèles) : « Connexion à Claude » (abonnement par défaut, ou clé API), budget mensuel en dollars, consommation du mois. `createRunner` choisit l'exécuteur ; en mode clé API sans clé dans le `.env`, une erreur claire est renvoyée et rien n'est lancé. Le dashboard n'affiche que la présence de la clé (`apiKeyConfigured`), jamais sa valeur.
- **Sécurité de la clé** : lue seulement dans `config.anthropicApiKey`, transmise à la CLI uniquement en mode clé API, **masquée** dans les erreurs et dans le journal en direct. En mode abonnement, toute clé du shell est écartée (comme avant). `ANTHROPIC_AUTH_TOKEN` n'est jamais transmis.
- **Coûts et budget** (`src/db/costs.ts`, `src/budget.ts`, `GET /api/costs`) : cumul par mois, projet et type de tâche. Le budget ne s'applique qu'en mode clé API et refuse de lancer une review ou une tâche de dev une fois atteint (sur l'abonnement, le coût est un équivalent API sans facture).
- Tests : 10 nouveaux (`agent/auth.test.ts`, `budget.test.ts`). Vérifié qu'ils échouent si la clé du shell n'est plus écartée.
- **Non testé en réel** : un appel avec une vraie clé Anthropic. L'hypothèse (la CLI utilise bien la clé de l'environnement) repose sur l'aide de la CLI et la documentation de Claude Code. **À valider** : mettre une clé dans le `.env`, choisir « Clé API » et lancer une petite review.
- **Limite** : le coût vient de `total_cost_usd` de la CLI, une estimation ; la facture d'Anthropic fait foi.

**A7, idée non planifiée : plusieurs fournisseurs de modèles (OpenAI et autres).** Ce n'est pas couvert par A3. La CLI Claude Code et le SDK ne pilotent que des modèles Claude, et ce sont eux qui fournissent les outils de l'agent (lecture, recherche, édition, commandes) avec leurs permissions. Pour OpenAI, il faudrait écrire notre propre boucle d'agent : outils confinés au dossier de travail, commandes autorisées une à une, aucun réseau, sortie structurée, limite de tours, annulation, et réécrire les prompts pour un autre modèle. C'est faisable mais c'est un chantier d'une autre taille, avec les garde-fous à reconstruire et à tester. À reprendre si un vrai besoin apparaît (coût, contrat, modèle précis), pas pour tester la clé API.

**C1a (2026-11-09)** : `src/db/` (`db.ts`, `sqlite.ts`, `postgres.ts`, `migrations.ts`, `index.ts`) et dépôts convertis (`reviews.ts`, `devTasks.ts`, `costs.ts`, `settings/store.ts`).
- **Interface `Db` asynchrone** (`all`, `get`, `run`, `exec`, `transaction`, version de schéma) et deux adaptateurs : SQLite (`node:sqlite`, rien à installer) et PostgreSQL (pilote `pg`). `openDb({ dataDir, databaseUrl })` choisit : `DATABASE_URL` dans le `.env` active PostgreSQL, sinon SQLite dans `DATA_DIR` comme avant.
- **SQL commun aux deux moteurs** : paramètres `?` (convertis en `$1` pour PostgreSQL), `INSERT ... ON CONFLICT ... RETURNING id`, horodatages en texte UTC identique des deux côtés, `CAST(COUNT(*) AS INTEGER)`, alias en snake_case. Ce qui diffère (type de clé primaire, flottant, défaut d'horodatage) passe par `db.sql`, y compris dans les migrations (`migrationsFor`).
- **Migrations** : la liste est la même, générée par moteur. Version de schéma : `PRAGMA user_version` sur SQLite (donc ta base existante est reconnue telle quelle), table `schema_migrations` sur PostgreSQL. Chaque migration tourne dans une transaction avec la mise à jour de la version. Une base plus récente que l'outil est refusée.
- **Conversion de tous les appelants** (pipelines, serveur, poller, démarrage, CLI) en asynchrone. Journal d'une tâche de dev (`src/dev/journal.ts`) : les écritures partent dans l'ordre, y compris depuis les callbacks synchrones de l'agent, ce que PostgreSQL ne garantirait pas sinon. Audit : aucun appel de dépôt sans `await` dans le code de production.
- **Vérifié** : les 111 tests existants, convertis et inchangés dans leur logique ; les scénarios de bout en bout (agent dev, review, budget) tournent maintenant **sur les deux moteurs** ; 19 tests de la couche de données (`db/db.test.ts`) sur SQLite, PostgreSQL embarqué (PGlite, un vrai moteur PostgreSQL) et **un vrai PostgreSQL 16 via le pilote `pg`** (conteneur Docker jetable, activé par `TEST_DATABASE_URL`, la base visée doit avoir « test » dans son nom car elle est vidée). Ta vraie base SQLite, copiée puis ouverte avec le nouveau code : version 3, mêmes reviews, tâches, coût et réglages, aucune migration appliquée. Le vrai serveur redémarré répond sur toutes ses routes.
- **Piège trouvé** : TypeScript accepte `{ ...promesse }` sans erreur, ce qui a fait échouer deux tests avant correction. À surveiller dans tout nouveau code.
- **Limites** : un seul processus à la fois (pas de verrou de migration entre plusieurs instances). Les tests PostgreSQL embarqués créent une base par test, ce qui rallonge la suite (environ 20 s). L'outil n'a pas encore tourné de bout en bout sur un serveur PostgreSQL avec ton GitLab : seuls les tests le couvrent.

**Lot B (2026-11-10)** : GitHub à côté de GitLab, B1 à B6.
- **Client et connecteur** : `src/github/` (types et client REST sans dépendance : jeton en `Authorization: Bearer`, version d'API, pagination par `Link` limitée au même serveur, noms de dépôt et identifiants validés avant tout appel) et `src/connectors/github.ts`. L'identifiant de projet neutre est l'identifiant numérique du dépôt ; son nom complet est retrouvé puis mis en cache.
- **Équivalences avec GitLab** : labels « Portée::valeur » émulés (l'ajout passe avant le retrait des autres labels de la même portée, pour ne jamais perdre le statut) ; vérifications (jobs et statuts classiques) ramenées aux mots de GitLab ; un titre « Draft: » donne une PR en brouillon ; assignation de la PR en simple confort (un échec est journalisé, la PR est gardée) ; approbation refusée si la tête de la PR a changé depuis la review, car GitHub ne le refuse pas de lui-même ; PR à reviewer trouvées par la recherche « avis demandé », brouillons écartés.
- **Plusieurs forges** : colonne « source » (`gitlab` ou `github`) sur les reviews, les tâches de dev et les réglages de projet (migration 4 : les données existantes deviennent GitLab, les réglages de projet sont recréés avec la clé source + numéro). `ForgeRegistry` : pour chaque forge, son connecteur, ses copies locales de dépôts (`repos` pour GitLab, `repos/github` pour GitHub) et l'identité de l'utilisateur chez elle. Un poller par forge, `/api/issues` réunit les forges (une forge en panne n'empêche pas d'afficher l'autre), les routes acceptent `?source=` (GitLab par défaut). Une review ou une tâche passe toujours par la forge qui l'a créée ; une forge absente donne une erreur claire.
- **Configuration** : `GITHUB_TOKEN` (jeton à portée fine) et `GITHUB_API_URL` (GitHub Enterprise seulement). GitLab devient facultatif (ses trois variables ensemble), avec au moins une forge. Un jeton GitHub invalide arrête le démarrage avec un message clair ; le compte GitHub est lu auprès de l'API.
- **Dashboard** : étiquette de forge sur les cartes quand plusieurs sont configurées, numéro de demande adapté (!12 chez GitLab, #12 chez GitHub), section Connexion des Paramètres qui liste les forges, projets identifiés par forge et numéro avec choix de la forge pour la recherche.
- **Vérifié** : 46 tests du client et du connecteur (mutations sur le contrôle de la tête et sur le lien de pagination), 7 tests de routage de bout en bout avec deux faux connecteurs aux mêmes numéros (mutations vérifiées), la migration sur des données de la version 3 (SQLite et PostgreSQL), la configuration. Ta vraie base est passée en version 4 sans perte (projets, reviews et tâches conservés, tous GitLab).
- **Limites connues** : réponses GitHub construites d'après la documentation, pas enregistrées sur un vrai compte, rien validé contre un vrai dépôt (jeton à portée fine sur `GET /issues`, recherche, push avec `x-access-token`). Une PR n'apparaît dans « à reviewer » que tant que l'avis est demandé : GitHub retire la demande une fois la review soumise, un nouveau commit ne relance donc une review que si l'avis est redemandé. L'état « résolu » des fils de discussion n'est pas dans l'API REST : il est laissé inconnu. Branches protégées par nom exact seulement (pas les règles d'ensemble). `removeSourceBranch` n'a pas d'effet (réglage par dépôt chez GitHub). Les « projets » GitHub pour les statuts ne sont pas gérés (labels seuls). L'unicité des reviews garde la contrainte d'origine (projet, demande, commit) sans la source : elle ne se heurterait que pour un même commit. L'écran n'a été vérifié qu'en syntaxe, pas dans un navigateur.

**C1b (2026-11-10)** : modèle de comptes, `src/db/accounts.ts` et migration 5.
- **Tables** : `users` (nom, email unique et facultatif), `workspaces` (nom, type `personal` ou `team`), `memberships` (espace, utilisateur, rôle `admin`, `member` ou `viewer`). Types, rôles et clés étrangères sont aussi contrôlés par la base (`CHECK`), pas seulement par le code.
- **Mode local inchangé à l'usage** : la migration crée « Utilisateur local » et « Espace local » (personnel) dont il est admin ; `localContext()` les retrouve. Ta vraie base est passée en version 5 au rechargement du serveur, sans perte (5 reviews, 2 tâches, 2 projets conservés).
- **Règles dans le dépôt** : un espace personnel n'a qu'un membre ; un utilisateur n'a qu'un espace personnel ; un espace garde toujours au moins un admin (le contrôle et l'écriture tiennent en une seule instruction SQL) ; une adresse email n'est utilisée qu'une fois (stockée en minuscules).
- **Pas encore fait** : les reviews, tâches et réglages ne sont pas rattachés à un espace (C4, avec les tests d'étanchéité) ; aucun contrôle de droits sur qui peut inviter ou changer un rôle (il faut un utilisateur connecté, C2) ; aucun écran.
- **Limite connue** : sur PostgreSQL, deux rétrogradations simultanées des deux seuls admins pourraient chacune voir l'autre encore admin et laisser l'espace sans admin (les transactions sont réservées aux migrations). Impossible sur SQLite (une seule connexion). À fermer en C4 avec un verrou.
- **Vérifié** : 10 tests de plus (220 au total) sur SQLite et PostgreSQL embarqué, dont la migration d'une base en version 4 avec données ; 5 mutations (garde du dernier admin, garde de l'espace personnel, email en minuscules, doublon de membre, un seul espace personnel) toutes détectées. Non testé sur un vrai serveur PostgreSQL via le pilote `pg`.

**C3 (2026-11-10)** : coffre à secrets, `src/secrets/` et migration 6.
- **Chiffrement** (`crypto.ts`) : AES-256-GCM, vecteur d'initialisation aléatoire à chaque chiffrement, enveloppe versionnée `v1:clé:iv:étiquette:donnée`. Le contexte (espace, utilisateur, nom du secret) est authentifié sans être stocké : recopier une valeur chiffrée dans une autre ligne la rend illisible. L'identifiant de la clé (début de son empreinte) permet la rotation.
- **Clé maître hors base** (`masterKey.ts`) : variable `SECRETS_MASTER_KEY` (32 octets en base64) ; sinon, en local seulement, fichier `data/master.key` créé au premier besoin en mode 600. En mode serveur (`DATABASE_URL`) la variable est obligatoire : pas de fichier généré dans un conteneur jetable. Si la clé est perdue alors que des secrets existent, l'outil refuse de démarrer au lieu d'en créer une autre. Rotation : nouvelle clé dans `SECRETS_MASTER_KEY`, ancienne dans `SECRETS_MASTER_KEY_PREVIOUS` ; au démarrage suivant les secrets sont rechiffrés.
- **Coffre** (`store.ts`) : table `secrets` (espace, utilisateur ou partagé de l'espace, nom, valeur chiffrée). La liste ne renvoie que noms et dates. Un secret lu ou enregistré est déclaré au journal.
- **Journaux** (`logger.ts`) : toute valeur déclarée (jetons du `.env`, clé maître, mot de passe de `DATABASE_URL`, secrets du coffre) est remplacée par `[secret]` dans la console, le fichier de journal et les messages d'erreur renvoyés au dashboard.
- **Dashboard** (Paramètres, Connexion) : saisie du **jeton GitHub** et de la **clé API Anthropic**, chiffrés en base. Le `.env` reste prioritaire (le dashboard affiche « défini dans le .env » et refuse d'écraser). Le jeton GitHub est contrôlé auprès de GitHub avant enregistrement (un jeton refusé empêcherait la forge de démarrer) et pris en compte au redémarrage ; la clé API sert tout de suite. Routes `GET /api/secrets` (origine et date, jamais la valeur), `POST /api/secrets/:nom` et `POST /api/secrets/:nom/delete`, avec l'en-tête anti-CSRF.
- **Pas encore fait** : jetons GitLab (il faudrait aussi l'adresse et le nom d'utilisateur dans les réglages) et Planio ; un jeton par utilisateur et par forge pour plusieurs personnes (les forges sont montées une fois au démarrage avec les jetons de l'utilisateur local ; la structure par utilisateur vient avec C2 et C4) ; changement du jeton GitHub sans redémarrage.
- **Limite** : la clé maître en fichier local est à côté de la base : elle protège d'une fuite de la base seule (sauvegarde, export), pas d'un accès au dossier de données. Pour le serveur, la clé vient du `.env`, hors du dossier de la base.
- **Vérifié** : 54 tests de plus (264 au total) ; 16 mutations (contexte authentifié, étiquette, déclaration au journal, étanchéité utilisateur, priorité du .env, contrôle du jeton, clé perdue, mode serveur, masquage, valeur renvoyée par la liste) toutes détectées. Non vérifié : le dashboard dans un navigateur (syntaxe seulement), un jeton GitHub réel.

**C4 (2026-11-10)** : isolation des données par espace, migration 7 et dépôts liés à un espace.
- **Rattachement** : reviews, tâches de dev, projets et réglages portent un `workspace_id` obligatoire (clé étrangère). Les journaux `actions` et `dev_task_events` suivent leur review ou leur tâche. Les clés d'unicité incluent l'espace : deux espaces peuvent reviewer la même demande de fusion, lancer un agent sur le même ticket ou configurer le même projet. Les secrets l'étaient déjà (C3).
- **Dépôts liés à un espace** : `createReviewRepo(db, workspaceId)`, `createDevTaskRepo`, `createCostRepo` et `createSettingsStore` : toute requête porte l'espace, aucune méthode ne permet d'en sortir. Une review ou une tâche d'un autre espace est introuvable (lecture, mise à jour) ; écrire dans son journal ou accrocher une reprise à la tâche d'un autre espace est refusé avec une erreur. Les coûts d'un espace n'incluent jamais ceux d'un autre.
- **Mode local inchangé** : tout reste dans l'espace de l'utilisateur local (`localContext()`), qui reçoit les données existantes.
- **Migration** (`workspaceScopeMigration.ts`) : SQLite ne sait pas modifier une clé, les tables sont reconstruites avec leurs tables filles ; PostgreSQL passe par des ALTER. Un premier essai a échoué sur la copie de ta vraie base (SQLite réécrit les clés étrangères quand on renomme une table parente) : la méthode a été changée avant tout passage sur la vraie base. Essai final sur la copie : effectifs identiques, contrôle des clés étrangères vide, intégrité ok, lignes identiques. Ta vraie base est en version 7 sans perte (5 reviews, 5 actions, 2 tâches, 137 événements, 2 projets, 1 réglage). Copie de sécurité d'avant : `data/backup-avant-c4.sqlite` (non versionnée, à supprimer quand tu es serein).
- **Garde-fou durable** : un test lit le code des dépôts et échoue si une requête sur une table d'espace ne nomme pas `workspace_id` (hors deux requêtes de maintenance de la clé maître, listées dans le test), ou si du SQL sur ces tables apparaît hors des dépôts (serveur, pipelines, poller, CLI).
- **Pas encore fait** : l'exécution multi-espaces. Un seul espace est servi par processus (celui de l'utilisateur local). Restent : un poller par espace et par forge, des files par espace avec limites de concurrence (C8), l'espace déduit de la connexion (C2), les réglages par portée équipe, utilisateur et projet (C5), l'audit des écritures sur les forges (C6). La limite de C1b sur le dernier admin en écriture simultanée reste ouverte : un verrou sera utile quand plusieurs personnes écriront en même temps (C8).
- **Vérifié** : 19 tests de plus (283 au total) sur SQLite et PostgreSQL embarqué ; 26 mutations (un filtre d'espace retiré à la fois : reviews, tâches, coûts, réglages) toutes détectées. Non vérifié : un serveur PostgreSQL réel (pilote `pg`).

**C2 (2026-11-10)** : connexion par compte GitLab ou GitHub, `src/auth/` et migration 8. Dormante tant qu'aucune application OAuth n'est configurée dans le `.env` : l'outil sert alors l'utilisateur local sans connexion, comme avant.
- **Flux** (`oauth.ts`, `routes.ts`) : code d'autorisation avec PKCE (S256) et un état à usage unique, valable 10 minutes, lié au navigateur par un cookie (sans lui, on pourrait connecter la victime au compte de l'attaquant en lui faisant ouvrir un retour piégé). Portées minimales : `read_user` (GitLab), `read:user` (GitHub). Le jeton d'accès sert une fois à lire le profil, puis il est jeté.
- **Sessions** (`sessions.ts`) : jeton aléatoire de 256 bits, seule son empreinte SHA-256 est en base ; cookie HttpOnly, SameSite=Lax, Secure quand `PUBLIC_URL` est en https ; 7 jours (`SESSION_DAYS`). Une session ne vaut que tant qu'elle n'a pas expiré et que l'utilisateur est toujours membre de son espace. Les sessions expirées sont purgées chaque heure. Les écritures restent protégées par l'en-tête `x-review-agent`.
- **Contrôle d'accès** : sans session valide, `/api` répond 401 et les pages renvoient vers `/login`. Seuls `/login` et `/auth/*` sont publics. `GET /api/me` dit qui est connecté (même sans connexion : l'utilisateur local). Le dashboard affiche la session dans Paramètres > Connexion avec un bouton Se déconnecter, et renvoie vers `/login` sur un 401.
- **Comptes** (`login.ts`) : un compte de forge se reconnaît à son identifiant numérique (pas au login, qui peut changer). Le propriétaire (`AUTH_OWNER`) reprend le compte local, donc ses données, à sa première connexion. Pas de rapprochement par adresse email (une adresse non vérifiée permettrait de prendre le compte d'autrui). Les personnes de `AUTH_ALLOWED_USERS` reçoivent un nouvel utilisateur et un espace personnel.
- **Propriétaire seul par défaut** : l'accès à d'autres personnes ne s'ouvre qu'en renseignant `AUTH_ALLOWED_USERS` (voir C8 : chaque personne a ses propres connexions aux forges, donc personne n'emprunte tes jetons). Sans exécution par personne (serveur sans `tenants`), une session d'un autre espace reçoit un 403.
- **Pas encore fait** : connexion par GitHub Enterprise ; invitations (ajout de membres à un espace d'équipe) ; limitation du débit des tentatives de connexion ; SSO d'entreprise (OIDC). La liste d'autorisation se fait par login de forge, qui peut être repris par quelqu'un d'autre après un changement de nom : à remplacer par des invitations liées à l'identifiant numérique.
- **Vérifié** : 24 tests (aller-retour complet avec une fausse forge, retour falsifié, rejeu, injection de code, expiration, attributs des cookies, aucun secret renvoyé), 19 mutations toutes détectées. Non vérifié : une vraie application GitLab ou GitHub, le navigateur.

**C8 (2026-11-10)** : exécution par personne et par espace, `src/tenants/`.
- **Une exécution par personne et par espace** (`manager.ts`) : SA connexion aux forges (jetons GitLab et GitHub de SON coffre), SA clé API Anthropic, SES dépôts de données liés à l'espace, SES deux files (reviews, tâches de dev) et SES pollers. Le propriétaire est le seul à utiliser les jetons et la clé du `.env` ; les autres partent d'une configuration sans aucun jeton et d'un dossier de données à part (`data/tenants/<espace>-<utilisateur>`), donc jamais de copie de dépôt partagée.
- **Serveur** (`app.ts`) : les routes ne changent pas. Les propriétés qui dépendent de la personne (`reviews`, `tasks`, `forges`, `config`, `vault`, files...) sont redirigées par requête, d'après la session, vers l'exécution de la personne (contexte asynchrone). Une personne sans forge voit des listes vides, jamais une erreur.
- **Limite commune** : `MAX_CONCURRENT_AGENTS` (1 par défaut) reviews et tâches de dev simultanées sur toute la machine, quelle que soit la personne ; les autres attendent leur tour dans l'ordre d'arrivée.
- **Jetons** : nouveau jeton GitLab personnel (contrôlé auprès de l'instance, le compte en est déduit). Après un changement de jeton de forge, les connexions de la personne sont reconstruites tout de suite, sans redémarrer l'outil ; si la reconstruction échoue, l'ancienne exécution continue de servir. `GITLAB_URL` peut être renseignée seule dans le `.env` (adresse de l'instance sans jeton).
- **Reprise après arrêt** : les reviews interrompues sont relancées et les tâches de dev passent en erreur, une fois par personne. Au lancement, le propriétaire et, si `AUTH_ALLOWED_USERS` est renseigné, toutes les personnes qui ont des jetons enregistrés repartent (leurs pollers doivent tourner même déconnectées).
- **Risque à connaître avant d'ouvrir à quelqu'un** : tous les agents tournent sur la même machine, avec le même utilisateur système. Une personne autorisée peut, en réglant les commandes autorisées d'un projet ou par injection dans un ticket, faire lire à un agent `data/master.key` ou la base. L'isolation par conteneur (lot D) n'existe pas : n'ouvrir qu'à des personnes de confiance, jamais à un tiers.
- **Pas encore fait** : arrêt des pollers des personnes inactives (gardés jusqu'à l'arrêt de l'outil), quotas par personne (C7), audit des écritures (C6), invitations (ajout d'un membre à un espace d'équipe), ordre équitable entre personnes (la file commune est première arrivée, première servie).
- **Vérifié** : 14 tests (exécution du propriétaire et des autres, dépôts séparés, jetons du coffre, reconstruction, reprise, limite commune, serveur de bout en bout avec deux personnes), 14 mutations toutes détectées. Non vérifié : avec de vrais comptes et de vrais agents.

**C9 (2026-11-10, préparé, non essayé)** : déploiement, voir `docs/deploiement.md`.
- **Fichiers** : `Dockerfile` (deux étages, Node 24, CLI Claude Code, utilisateur sans droits), `docker-compose.yml` (application et PostgreSQL 16), `.dockerignore`, `tsconfig.build.json` (compilation sans les tests), `scripts/backup.sh` et `scripts/restore.sh`.
- **Durcissement** : système de fichiers en lecture seule hors volume de données et `/tmp`, aucune capacité Linux, `no-new-privileges`, mémoire (2,5 Go) et processeurs (2) plafonnés, base sans port publié sur un réseau sans sortie, application publiée sur `127.0.0.1` seulement (accès par tunnel SSH).
- **Sauvegardes** : `pg_dump` compressé, vérifié, 14 gardées, lisible par son propriétaire seul ; la clé maître n'y est jamais incluse. Restauration protégée par `--yes`.
- **Vérifié** : syntaxe du fichier compose (`docker compose config` sur un `.env` factice), syntaxe des scripts, compilation de production et chargement des 68 modules sans erreur. **Non vérifié** : `docker build`, le démarrage, la coexistence avec rag-saas, la mémoire réelle, une sauvegarde et une restauration réelles.
- **Pas fait** : TLS (inutile avec le tunnel), import de la base SQLite locale vers PostgreSQL, rotation des journaux, supervision (G2), restauration testée automatiquement (G3).
- **Environnement des agents filtré** (`src/claude/process.ts`) : l'agent ne reçoit plus que PATH, HOME, la langue, les proxys et certificats, `XDG_*`, `CLAUDE_*` et `ANTHROPIC_*` (hors noms qui ressemblent à des secrets). Les jetons de forge, la clé maître, l'adresse de la base et les secrets OAuth du `.env` n'y sont plus. Ce n'est **pas** une isolation : un processus du même utilisateur lit l'environnement de son parent (`/proc`) ; seuls des conteneurs par personne (lot D) l'empêchent. 4 tests, 4 mutations détectées. Risque de régression : une commande de projet qui dépendrait d'une variable d'environnement non listée ne la verrait plus (à constater lors d'une vraie exécution, voir `docs/a-tester.md`).

**C6 (2026-11-11)** : journal d'audit des écritures sur les forges, migration 9.
- **Ce qui est tracé** : labels posés sur un ticket, demande de fusion créée, commentaire posté, approbation, branche poussée. Pour chacune : qui (personne), quand, forge, cible (`projet/numéro` ou nom de branche), précisions utiles, résultat (réussie ou en échec avec son message d'erreur, secrets masqués). Les lectures ne sont pas tracées. Le texte d'un commentaire n'est jamais gardé, seulement sa longueur.
- **Comment** (`src/connectors/audited.ts`) : chaque connecteur et chaque copie de dépôts est enveloppé au moment où l'exécution d'une personne se construit (`tenants/manager.ts`). Les pipelines n'ont rien à faire : toute écriture passe par là. Un journal en panne ne bloque jamais l'action. Une nouvelle méthode d'écriture d'un connecteur s'ajoute à `CONNECTOR_WRITES`.
- **Où le voir** : Paramètres > Journal des actions (30 dernières lignes), ou `GET /api/audit?limit=&before=`. Chaque personne ne voit que son journal, dans son espace.
- **Bug trouvé par ce test** : `deps.audit` n'était pas dans la liste des propriétés propres à une personne, donc la seconde personne lisait le journal du propriétaire. La règle est maintenant inversée (`SHARED_KEYS` dans `server/app.ts`) : une propriété ajoutée est propre à la personne par défaut.
- **Pas encore fait** : purge automatique (E10), vue d'ensemble pour un admin d'équipe, journal des actions de l'agent sur le disque ou des changements de réglages.
- **Vérifié** : 9 tests (écritures, lectures, échecs avec secret masqué, journal en panne, pushs, pagination, étanchéité entre espaces, bout en bout avec deux personnes) et 5 mutations détectées. Non vérifié : sur une vraie forge.

**Déclenchement des reviews (2026-11-12)** : réglage Paramètres > Déclenchement des reviews, par espace.
- **Trois choix** : « Toutes » (défaut, comportement d'origine : chaque MR où tu es relecteur est analysée dès qu'elle passe en Ready), « Projets configurés seulement » (les MR des autres projets ne sont même pas enregistrées, elles le sont dès que le projet est configuré), « À la main » (la MR est enregistrée avec le statut **À lancer**, rien ne démarre ; un bouton « Lancer la review » dans le détail met l'analyse en file).
- Le réglage est relu à chaque cycle du poller : il s'applique sans redémarrer. Une review « À lancer » n'est pas relancée par un redémarrage. Lancer une review déjà en file est refusé (409), donc un double clic ne la lance pas deux fois. Le lancement est inscrit au journal des actions de la review.
- **Vérifié** : 5 tests de plus (344 au total) et 7 mutations détectées ; le dashboard n'a été vérifié qu'en syntaxe.

## Lot B : GitHub (jalon J2)

Objectif : traiter un ticket GitHub et reviewer une PR, comme aujourd'hui pour GitLab.
- **Décisions** : jeton personnel à portée fine pour l'outil local (Issues, Pull requests et Contents en lecture et écriture, Metadata, Checks et Statuses en lecture, limité aux dépôts choisis), application GitHub pour la plateforme multi-utilisateur (lot C). Reste à décider : gestion des « projets » GitHub pour les statuts (labels seuls au départ).
- **Critères** : lister les tickets assignés, lire la discussion, créer une branche et pousser sur la branche du ticket seulement, ouvrir une PR Draft, commenter, lire les vérifications, mêmes garde-fous de branche.
- **Tests** : réponses enregistrées, dépôt local de test pour le push.

## Lot C : serveur multi-utilisateur (jalon J3)

Objectif : plusieurs personnes utilisent la même instance, chacune avec ses données, ses jetons et ses réglages. Les agents tournent en clé API uniquement à ce stade.
- **Décisions (2026-11-09)** : base de données **PostgreSQL** (cohérent avec les autres projets de l'utilisateur) ; déploiement avec **Docker** (docker compose), serveur à choisir.
- **Décidé ensuite (2026-11-09)** : SQLite pour l'outil local **et** PostgreSQL pour le serveur, derrière une même interface (C1a, fait). Serveur : le **VPS OVH existant** pour commencer (VPS-2 : 4 vCores, 8 Go de mémoire, 75 Go de disque, Ubuntu 26.04, région Canada, une base Elasticsearch déjà présente, aucun nom de domaine). Mesuré le 2026-11-09 : ce VPS héberge déjà rag-saas en production (3 conteneurs Docker : Caddy qui tient les ports 80, 443 et 8443, Elasticsearch 8.19 sans port publié donc non exposé, un service d'OCR). Elasticsearch prend environ 1,9 Go, il reste environ 5 Go disponibles, pas de swap. La capacité suffit pour un pilote à une ou deux personnes (2 exécutions d'agent simultanées au plus), mais mélanger du code généré par un agent et un service en production est un risque. **Décision de l'utilisateur (2026-11-09) : pilote sur ce même VPS** tant que rag-saas n'a pas de clients payants (usage personnel uniquement) ; VPS dédié dès les premiers abonnements. Garde-fous obligatoires : swap, limites de mémoire et de disque par exécution, un seul run à la fois au début, réseau Docker dédié, jamais le socket Docker dans un conteneur d'agent, utilisateur Linux dédié, `.env` en mode 600. Accès par tunnel SSH : la plateforme n'écoute que sur 127.0.0.1 et n'a pas encore de connexion, donc ne jamais l'exposer sur Internet avant C2. Un nom de domaine (ou sous-domaine) n'est nécessaire que pour ouvrir à d'autres personnes.
- **Critères** : aucune requête ne lit ou n'écrit hors de l'espace de l'utilisateur connecté (test d'étanchéité par table), secrets chiffrés au repos et absents des journaux, CSRF et sessions sécurisées, déploiement reproductible.
- **Risque** : migrer l'existant (une seule base locale) vers le modèle multi-espaces sans perdre les données.

## Lot D : environnements par utilisateur (jalon J4)

Objectif : un conteneur par utilisateur, décrit par `devcontainer.json`, dans lequel l'agent travaille et teste ; seul un patch en sort (`vision-plateforme.md`, section 3.4).
- **Décisions requises** : serveur et capacité (Docker rootless disponible ?), granularité des environnements, liste blanche d'images de base et de dépôts de paquets, mécanisme des paquets privés (D10), validation par Anthropic de l'usage d'abonnements dans des conteneurs hébergés avant d'ouvrir à d'autres équipes.
- **Critères** : le conteneur n'a aucun identifiant de forge ni accès réseau à la forge, il ne produit qu'un patch, le patch passe les contrôles fixes (A2) avant application, l'arrêt automatique libère les ressources, un utilisateur ne voit jamais le conteneur d'un autre.
- **Risque** : sécurité de l'exécution de code généré. D7 et G1 ne sont pas optionnels avant une ouverture au-delà de l'équipe.

## Lot E : support client (jalon J5)

Objectif : de la demande client au correctif, avec données caviardées et validation humaine (`parcours-utilisateur.md`, section 4.1).
- **Bloquant (E9)** : analyse d'impact et avis du DPO avant toute donnée réelle. Les durées de conservation (proposition : 30 jours après clôture) et les conditions du fournisseur selon le mode sont à confirmer.
- **Critères** : le modèle ne reçoit jamais une valeur personnelle réelle (vérifié sur un corpus de demandes réelles anonymisées), le mode strict bloque en cas de doute, aucune réponse ne part chez le client sans validation humaine, la suppression à la demande est effective.

## Lot F : tickets internes (jalon J6)

Objectif : créer des tickets dans la plateforme et publier les MR dessus, avec un Gitea embarqué pour les projets sans forge. À lancer seulement si le besoin est confirmé.

## Lot G : industrialisation (jalon J6)

Objectif : tenir en production : isolation renforcée, supervision, sauvegardes testées, notifications, export et suppression de compte, évaluation de Coder et de Kubernetes si le nombre d'utilisateurs le justifie.

## Décisions et blocages à lever

| Décision | Bloque | À trancher par |
|---|---|---|
| Première vraie clé Anthropic, pour valider A3 en réel | validation de A3 | Utilisateur |
| ~~SQLite ou PostgreSQL~~ **PostgreSQL** (2026-11-09). SQLite conservé en local (2026-11-09), serveur : VPS OVH existant. Reste : VPS dédié ou partagé avec rag-saas, nom de domaine, Docker rootless | C1, C9, D2 | Utilisateur |
| Forge à supporter en premier au-delà de GitLab | B | Utilisateur |
| ~~Jeton GitHub ou application GitHub~~ **Jeton personnel à portée fine** pour l'outil local, **application GitHub** pour la plateforme (2026-11-09) | B1, C2 | décidé |
| Validation écrite d'Anthropic pour les abonnements en conteneur hébergé | D8 (ouverture hors équipe) | Utilisateur avec Anthropic |
| Avis du DPO, AIPD, durées de conservation | E (données réelles) | Utilisateur avec le DPO |
| Stacks d'environnement prioritaires | D9 | Utilisateur |
| Besoin réel de tickets internes à court terme | F | Utilisateur |

## Prochain lot

1. **A3** dès qu'une clé API de test est disponible.
2. **Lot B** (GitHub) : fait (2026-11-10). Il reste à le valider sur un vrai dépôt : jeton à portée fine dans le `.env`, un dépôt de test avec quelques tickets.
3. **A6** : coûts par utilisateur et budget en mode API (dépend d'A3).
4. **Essayer C9 sur le VPS** (`docs/deploiement.md`), puis **D** (conteneurs par personne), qui conditionne toute ouverture à des personnes autres que de confiance. C1b à C4, C8 sont faits et C9 est préparé (2026-11-10).

A1, A2, A4 et A5 sont faits (2026-11-09).
