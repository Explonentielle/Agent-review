# Vision : plateforme de développement assistée par agents

Statut : **spec et plan, rien d'implémenté**. Ce document décrit la cible et l'ordre des étapes. Chaque étape passera par une clarification avant d'être codée (méthode du `CLAUDE.md`).

Voir aussi : `docs/parcours-utilisateur.md` (parcours complet de la première connexion à l'usage quotidien, écosystèmes à brancher).

## 1. Objectif

Faire évoluer review-agent, outil local mono-utilisateur, en une **plateforme hébergée** où chaque utilisateur :

- dispose de **son environnement de développement** : un conteneur avec ses projets, les langages et les dépendances dont ils ont besoin ;
- branche ses **sources de tickets** : GitLab, GitHub, ou des tickets créés dans la plateforme ;
- fait traiter ses tickets par un **agent Claude** (dev et review), avec **son** abonnement Claude Code ou **sa** clé API ;
- garde les garde-fous actuels : push limité à la branche du ticket, MR toujours en Draft, décisions d'agir dans du code déterministe.

## 2. Principe fondateur : « ton environnement, ta session Claude »

La plateforme **ne voit, ne stocke et n'utilise jamais** les identifiants claude.ai d'un utilisateur.

- **Abonnement** : l'utilisateur ouvre un terminal web dans **son** conteneur, y lance `claude` puis `/login`. La session est enregistrée dans le volume de son conteneur (`~/.claude/`) et n'est utilisée que pour ses propres tâches, dans son propre environnement, comme dans un Codespace ou un devcontainer.
- **Clé API** : l'utilisateur la saisit comme secret personnel. Elle est chiffrée au repos et injectée dans son seul conteneur, uniquement pour les processus de l'agent.
- Aucun conteneur, aucune session, aucune clé n'est partagé entre utilisateurs.

**À faire valider par Anthropic** avant une ouverture au-delà de l'équipe : l'usage d'abonnements individuels dans des conteneurs hébergés par l'entreprise, chacun connecté et utilisé par son seul titulaire.

## 3. Architecture cible

```
                     ┌──────────────────── Plan de contrôle (serveur) ────────────────────┐
 Navigateur ───────► │ Dashboard + API      Comptes (OAuth GitLab / GitHub)               │
                     │ Connecteurs tickets  (GitLab, GitHub, tickets internes)            │
                     │ File des tâches      Garde-fous + push + MR (code déterministe)    │
                     │ Orchestrateur        crée / démarre / arrête les conteneurs        │
                     └─────────────┬───────────────────────────────────────────────────────┘
                                   │ tâches, événements (journal en direct)
                     ┌─────────────▼──────────── Plan de données (par utilisateur) ───────┐
                     │ Conteneur de l'utilisateur (image issue d'un devcontainer.json)    │
                     │  - projets clonés, langages, dépendances, base de test éventuelle  │
                     │  - CLI claude (session /login de l'utilisateur) ou clé API         │
                     │  - démon agent : exécute les tâches, renvoie le journal            │
                     │  - terminal web (+ éventuellement VS Code dans le navigateur)      │
                     │  - volume persistant                                               │
                     └────────────────────────────────────────────────────────────────────┘
```

### 3.1 Plan de contrôle

- **Comptes** : connexion par OAuth GitLab ou GitHub plutôt que des tokens collés. Le token OAuth sert aussi aux appels API et au push, avec renouvellement automatique.
- **Connecteurs de tickets** : une interface commune (lister les tickets assignés, lire un ticket et sa discussion, poser un label, créer une MR, commenter, approuver). Implémentations : GitLab (l'existant), GitHub, tickets internes.
- **Tickets internes** : créés et suivis dans le dashboard. Pour un projet sans forge, la MR est publiée sur une forge interne (**Gitea** embarqué), pas sur un système de revue maison.
- **Garde-fous et push hors de portée de l'agent** : seul un patch sort du conteneur. Le plan de contrôle l'applique sur un worktree propre, refait les contrôles, committe, pousse et crée la MR avec le jeton de l'utilisateur, qui n'entre jamais dans le conteneur (détail en 3.4).
- **Orchestrateur** : crée le conteneur d'un utilisateur à partir d'un modèle de projet, le démarre à la demande, l'arrête après inactivité, gère les quotas.

### 3.2 Plan de données : le conteneur utilisateur

- **Image** : décrite par un `devcontainer.json` par projet (standard ouvert) : langage, version, extensions système, commande d'installation des dépendances (`composer install`, `npm ci`...), services annexes (base de données de test).
- **Démon agent** : reçoit une tâche du plan de contrôle, prépare le worktree, lance l'agent (CLI avec la session de l'utilisateur, ou SDK avec sa clé), diffuse le journal, rend le rapport et le commit. C'est le pipeline actuel de `src/dev/` déplacé dans le conteneur.
- **Tests** : l'agent lance les tests du projet directement dans l'environnement qui a les bonnes dépendances. Le problème actuel des tests sous Docker (roadmap, item 31) disparaît.
- **Terminal web** : pour `/login`, et pour reprendre la main sur une tâche (`claude --resume`) sans installation locale.

### 3.3 Isolation et sécurité

- Un conteneur par utilisateur, sans privilèges (Docker rootless, ou un runtime d'isolation renforcée de type gVisor ou Sysbox), quotas CPU, mémoire et disque.
- Réseau sortant filtré : forges et API Anthropic autorisées, le reste sur liste blanche par projet.
- Secrets chiffrés au repos, jamais affichés, jamais présents dans les journaux.
- Journal d'audit des actions sur les forges (commentaires, approbations, push, MR).
- Les règles actuelles restent valables : garde-fous des prompts non modifiables, push limité à la branche du ticket, pas de `--force`, MR en Draft.

### 3.4 Accès au code et sortie des modifications (décidé le 2026-11-09)

Principe : **le conteneur ne détient aucun identifiant de forge et n'a aucune route réseau vers elle. Seul un patch en sort.**

Flux d'une tâche :

1. Le plan de contrôle met à jour son miroir du dépôt avec le jeton de l'utilisateur (chiffré, jamais exposé).
2. Il dépose dans le conteneur une **copie de travail autonome** : le commit de base extrait (`git archive` ou clone local), sans remote ni identifiants. Aucun `.git/config` ne pointe vers la forge.
3. L'agent travaille et teste dans le conteneur. Il ne peut rien pousser : pas d'identifiants, pas d'accès réseau à la forge.
4. En fin de tâche, le conteneur remet **uniquement un patch** (`git diff --binary` depuis le commit de base) et le rapport. Le plan de contrôle ne lit jamais un dépôt git produit par le conteneur, ce qui écarte les crochets, configurations et références piégés.
5. Le plan de contrôle applique le patch sur un worktree propre qu'il a créé lui-même, après des **contrôles fixes** : aucun chemin sous `.git/`, aucun lien symbolique sortant du dépôt, aucun chemin absolu ni `..`, taille maximale, fichiers de secrets, caractère de remplacement et encodage d'origine (ex. ISO-8859-1), fichiers sensibles signalés. Il committe ensuite avec l'identité de l'utilisateur, revérifie que la branche est autorisée, pousse, et crée la MR.
6. La **reprise avec consignes** suit le même flux, depuis la branche telle qu'elle est sur la forge. Le terminal web (`claude --resume`) aussi : pour publier, l'utilisateur déclenche l'extraction d'un patch, il ne pousse pas lui-même depuis le conteneur.

**Pourquoi pas un relais git avec un jeton à durée courte** : un jeton présent dans le conteneur est lisible par un agent manipulé (injection de prompt dans un ticket ou dans un fichier). De plus, à notre connaissance, les forges ne savent pas limiter un jeton à une branche : GitHub (jetons à portée fine, applications) et GitLab (jetons de projet) s'arrêtent au dépôt ou au projet. La restriction de branche resterait une convention, pas une garantie.

**Réseau et dépendances** :
- Pendant une tâche, la sortie réseau du conteneur est limitée à une liste blanche : API Claude, et éventuellement un **proxy de paquets** contrôlé par la plateforme (miroir Composer, npm, PyPI avec paquets autorisés). Pas de forge, pas d'Internet libre.
- Les dépendances sont installées à la **construction de l'image** (cache dans le volume), pas à l'exécution.
- Dépôts de paquets privés : jeton en lecture seule propre à l'environnement, fourni comme secret de construction uniquement, absent à l'exécution.

**Risques résiduels assumés** :
- L'agent lit le code du projet. L'isolation et la liste blanche réseau limitent ce qui peut sortir. Une consigne piégée peut en revanche tenter de glisser du contenu indésirable dans le patch : d'où les contrôles fixes de l'étape 5 et la relecture humaine de chaque MR.
- La session Claude de l'utilisateur vit dans son conteneur. Un agent manipulé pourrait chercher à la lire : le réseau limité à l'API Claude, un conteneur par utilisateur et des droits sans privilèges limitent l'impact à son propre compte.

**Lien avec l'outil local actuel** : l'outil local applique déjà une partie du principe (l'agent ne commite ni ne pousse, l'outil contrôle puis pousse). Le passage au patch seul est l'étape qui sépare physiquement l'agent des identifiants.

### 3.5 Données personnelles du support (principe décidé le 2026-11-09)

Principe : **caviarder avant tout prompt**. Le modèle ne voit jamais de donnée personnelle réelle. Les valeurs réelles restent dans le plan de contrôle.

**Détection**, dans le plan de contrôle, avant tout envoi au modèle :
- détecteurs à validation : emails, téléphones, IBAN (contrôle modulo 97), cartes bancaires (Luhn), numéro de sécurité sociale français (clé de contrôle), numéros de passeport et de pièce d'identité selon formats, dates de naissance (à proximité d'un mot-clé), adresses postales (heuristique), URL contenant un jeton ;
- champs structurés du helpdesk : demandeur, contacts, signature, noms de passagers connus du ticket ;
- modèles propres à l'équipe (ex. numéros de dossier de voyage), avec un choix par type : **caviarder** ou **conserver** (un numéro de dossier est souvent utile au diagnostic) ;
- noms propres libres : reconnaissance locale, sans appel externe, en complément.

**Remplacement** par des repères stables (`[EMAIL_1]`, `[NOM_1]`, `[TEL_1]`...), identiques dans tout le fil d'un ticket pour que l'agent comprenne les relations entre personnes.

**Table de correspondance** : elle reste dans le plan de contrôle. La réidentification se fait à l'affichage pour le support et à l'envoi, après validation humaine. Le brouillon de réponse de l'agent est écrit avec des repères.

**Autres règles** :
- pièces jointes (captures, PDF) non envoyées par défaut ; extraits de journaux envoyés seulement après caviardage ;
- **mode strict au départ** : si un motif sensible est suspecté mais ne peut pas être remplacé proprement, la demande est marquée « à relire » et rien n'est envoyé au modèle avant validation du support ;
- **conservation** (proposition à valider avec le DPO) : le ticket d'origine reste dans le helpdesk, qui est la source de vérité. La plateforme ne garde que la version caviardée, les diagnostics caviardés et la table de correspondance, supprimée 30 jours après la clôture du ticket. Suppression à la demande par personne ou par ticket (droit à l'effacement). Journaux de prompts stockés caviardés ;
- **fournisseur** : seuls des textes caviardés partent chez Anthropic. Les conditions de conservation et d'entraînement dépendent du mode (abonnement personnel, API, offre Team ou Entreprise) : à confirmer par contrat avant d'ouvrir le support à de vraies données ;
- **validation humaine** : obligatoire par défaut pour tout message sortant vers un client. Assouplissement envisageable par catégorie, seulement après un taux d'accord mesuré (proposition : au moins 95 % sur 50 réponses de la catégorie), et jamais pour les réclamations, remboursements, données personnelles et sujets juridiques.

**Limites assumées** : le caviardage réduit le risque, il ne l'élimine pas. Il sera mesuré (rappel et faux positifs) sur un corpus annoté de demandes réelles avant toute mise en service, et une analyse d'impact (AIPD) est nécessaire.

## 4. Construire ou s'appuyer sur l'existant

| Brique | Options | Recommandation |
|---|---|---|
| Environnements par utilisateur | Docker piloté par l'outil, **Coder** (open source, modèles Terraform, terminal et VS Code web), DevPod | Démarrer avec Docker piloté par l'outil sur un serveur. Évaluer Coder si le nombre d'utilisateurs ou les besoins d'isolation grandissent. |
| Description des environnements | `devcontainer.json` | Oui : standard, réutilisable dans VS Code en local. |
| Forge pour les tickets internes | **Gitea** embarqué | Oui, plutôt qu'une revue de code maison. |
| Terminal web | ttyd, xterm.js | ttyd dans le conteneur, exposé via le plan de contrôle (authentifié). |
| Agent | CLI Claude Code (abonnement) ou Claude Agent SDK (clé API) | Les deux, derrière une interface d'exécution commune. |

La valeur propre de l'outil est au-dessus de ces briques : tickets, agent, garde-fous, reviews, dashboard, adaptation aux stacks et workflows réels.

## 5. Étapes

Chaque étape est livrable et utile seule.

1. **Cœur indépendant de la forge et du moteur** (local, sans serveur)
   - interface de connecteur de tickets, GitLab migré dessus ;
   - interface d'exécution d'agent : CLI avec abonnement (existant), SDK avec clé API ;
   - bénéfice immédiat : l'outil local accepte une clé API, et le code est prêt pour GitHub.
2. **GitHub** : connecteur GitHub (issues, PR, review), en local.
3. **Multi-utilisateur sur un serveur, sans conteneurs par utilisateur**
   - comptes via OAuth GitLab / GitHub, données et réglages par utilisateur, secrets chiffrés ;
   - agents en **clé API uniquement** à ce stade (pas de session d'abonnement côté serveur).
4. **Conteneur par utilisateur**
   - orchestrateur Docker, modèles `devcontainer.json`, volume persistant, terminal web ;
   - démon agent dans le conteneur, push et garde-fous dans le plan de contrôle ;
   - option abonnement : `/login` par l'utilisateur dans son terminal.
5. **Tickets internes** et Gitea embarqué.
6. **Industrialisation** : isolation renforcée, filtrage réseau, quotas, supervision, sauvegardes, éventuellement Kubernetes.

## 6. Risques

- **Conditions d'utilisation** des abonnements dans des conteneurs hébergés : à valider (section 2). En attendant, le mode serveur fonctionne en clé API.
- **Coût d'hébergement** : un conteneur avec dépendances et base de test par utilisateur consomme du disque et de la mémoire. Arrêt automatique après inactivité indispensable.
- **Sécurité** : la plateforme exécute du code et des commandes générées par un modèle, avec accès aux dépôts. L'isolation et le filtrage réseau ne sont pas optionnels.
- **Charge de maintenance** : orchestrateur, images, mises à jour de sécurité. C'est la raison de garder Coder en option.
- **Concurrence** : Claude Code sur le web, Codex, Copilot coding agent, GitLab Duo, Devin, OpenHands. Le positionnement reste le sur-mesure (forge auto-hébergée, workflows, stacks legacy, garde-fous).

## 7. Concurrence et positionnement (relevé du 2026-11-09)

Relevé fait à partir de sources souvent tierces : tarifs et disponibilités à revérifier sur les sites officiels avant toute présentation.

| Produit | Ce qu'il fait | Où il se branche | Limite par rapport à notre cible |
|---|---|---|---|
| GitLab Duo Agent Platform | Ticket vers MR Draft (« Developer flow »), review de MR, correction de vulnérabilités | GitLab.com, Self-Managed, Dedicated | Licence Premium ou Ultimate, facturation à l'usage, GitLab récent, AI Gateway à installer pour des modèles auto-hébergés. GitLab seulement |
| GitHub Copilot coding agent | Ticket assigné à Copilot : branche, code, tests, PR Draft. Déclenchable depuis GitHub, IDE, Jira, Slack, Linear | GitHub | Code sur GitHub uniquement. Facturation à l'usage depuis juin 2026 |
| Atlassian Rovo Dev | Code et PR Draft depuis un ticket Jira, aussi via les automatisations Jira ; review des PR contre les critères d'acceptation | Jira, Bitbucket, GitHub | Écosystème Atlassian. Rien pour Planio, peu pour GitLab auto-hébergé |
| Claude Code (web, CLI, GitHub Action) | Agent généraliste, tâches cloud ou locales, review de PR | Surtout GitHub en mode cloud, partout en CLI | Pas de workflow ticket vers MR clé en main pour GitLab ou Planio (c'est notre moteur) |
| OpenAI Codex | Tâches asynchrones en sandbox cloud, CLI, IDE, review de PR GitHub | Surtout GitHub | Peu de choses pour GitLab auto-hébergé et le support |
| Devin (Cognition) | Agent autonome dans son environnement cloud, intégrations Slack et trackers | Cloud | Cher, fermé, le code part chez le fournisseur |
| OpenHands | Agent open source, interface web, CLI, SDK, auto-hébergeable en Docker | À brancher soi-même | Brique, pas produit : workflow, tickets, garde-fous à construire |

**Positionnement retenu** : pas « un agent qui code mieux », mais **le workflow de bout en bout d'une équipe qui jongle entre plusieurs outils**, là où les grandes plateformes sont enfermées dans leur écosystème :

1. **Du ticket de support au correctif, en un seul flux** : ticket de support (Planio, Jira Service Management...), diagnostic dans le code, réponse client rédigée, ticket de dev créé, agent, MR. Aucun concurrent ne couvre ce flux hors de son écosystème. C'est l'angle le plus fort.
2. **Multi-outils** : GitLab auto-hébergé, Planio / Redmine, Jira, GitHub dans un seul dashboard.
3. **Aucune licence imposée** : abonnement Claude ou clé API de l'utilisateur, pas de GitLab Ultimate ni de siège Devin.
4. **Contrôle humain et garde-fous configurables** : mode ombre, règles de décision déterministes, taux d'accord mesuré, push limité à la branche du ticket, consignes par projet, prompts modifiables.
5. **Code legacy et hétérogène** : FuelPHP, PHP ancien, ISO-8859-1, plusieurs versions de Laravel, avec consignes par projet et contrôles dédiés.
6. **Environnements avec les vraies dépendances**, chez soi, branchés sur sa propre forge.

**À vérifier avant de présenter l'outil** : la licence GitLab de l'entreprise. En Premium ou Ultimate, une partie du ticket vers MR et de la review existe peut-être via Duo ; l'outil reste pertinent pour le support, le multi-outils et les garde-fous, mais il faut le savoir.

Sources : [GitLab Duo Agent Platform](https://docs.gitlab.com/user/duo_agent_platform/), [Issue to MR flow](https://about.gitlab.com/blog/vibe-coding-with-gitlab-duo-agent-platform-issue-to-mr-flow/), [GitLab 18.9](https://alternativeto.net/news/2026/2/gitlab-18-9-introduces-duo-agent-general-availability-vulnerability-resolution-and-more), [Copilot coding agent](https://www.morphllm.com/copilot-coding-agent), [Copilot et facturation à l'usage](https://clickup.com/learn/topic/ai/tools/github-copilot/), [Rovo Dev dans Jira](https://www.atlassian.com/blog/announcements/rovo-dev-in-jira), [Rovo Dev Q&R](https://community.atlassian.com/forums/Rovo-for-Software-Teams-Beta/Webinar-Q-amp-A-Rovo-Dev-in-Jira/ba-p/3215401), [Claude Code vs Codex](https://www.sitepoint.com/claude-code-vs-codex-2026/), [Codex, Devin, Claude Code](https://vibecodehq.pages.dev/guides/autonomous-ai-agents-codex-devin-claude-code), [OpenHands et autres](https://ai-tools-insight.pages.dev/posts/hermes-agent-vs-competitors-2026).

## 8. Décisions prises et pistes écartées (historique)

| Date | Sujet | Décision | Pourquoi |
|---|---|---|---|
| 2026-11-04 | Moteur d'agent en local | CLI `claude -p` avec l'abonnement de l'utilisateur, clés API retirées de l'environnement | Usage headless documenté de Claude Code ; le SDK exige une clé API pour un produit tiers |
| 2026-11-04 | Serveur MCP GitLab | Écarté | Donnerait à l'agent un accès direct à GitLab ; l'outil garde la main sur push et MR |
| 2026-11-06 | Infos d'entreprise | Rien dans le code : URL et token dans `.env`, le reste dans le dashboard | Dépôt partageable et réutilisable par d'autres équipes |
| 2026-11-09 | Plateforme sur serveur avec un seul abonnement | Écarté | Un abonnement claude.ai est personnel ; quota épuisé |
| 2026-11-09 | Saisie login / mot de passe claude.ai dans le front | Écarté | Pas de login par mot de passe (OAuth navigateur), produirait de toute façon un token, schéma d'hameçonnage |
| 2026-11-09 | Token d'abonnement par utilisateur (`claude setup-token`) stocké ou collé à chaque tâche | Non retenu | Secrets sensibles centralisés, conditions d'utilisation incertaines |
| 2026-11-09 | Modèle d'accès à Claude sur la plateforme | **« Ton environnement, ta session Claude »** : `/login` par l'utilisateur dans son propre conteneur, ou clé API personnelle chiffrée | La plateforme ne manipule jamais d'identifiants claude.ai ; à faire valider par Anthropic avant ouverture large |
| 2026-11-09 | Forge pour tickets internes | Gitea embarqué plutôt qu'une revue de code maison | Coût de construction d'une forge |
| 2026-11-09 | Accès au code depuis le conteneur | Le plan de contrôle clone et pousse. Le conteneur travaille sur une copie autonome sans identifiants ni accès réseau à la forge, et **seul un patch en sort** (3.4) | Un jeton dans le conteneur est lisible par un agent manipulé, et les forges ne limitent pas un jeton à une branche. Relais à jeton court écarté |
| 2026-11-09 | Données personnelles du support | Caviardage avant tout prompt, repères stables, table de correspondance dans le plan de contrôle seul, mode strict au départ (3.5) | Le modèle n'a pas besoin des valeurs réelles pour diagnostiquer ; réduit l'exposition RGPD |
| 2026-11-09 | Validation humaine du support | Obligatoire par défaut. Assouplissement par catégorie après taux d'accord mesuré, jamais pour les catégories sensibles (seuils à confirmer) | Responsabilité sur ce qui part chez le client |

## 9. Questions ouvertes (à trancher avant l'étape concernée)

- Hébergement : quel serveur (interne, VPS, cloud), avec quelles ressources ? Docker y est-il disponible ?
- Public visé au départ : l'équipe seulement, toute l'entreprise, ou des utilisateurs externes ?
- Forges à supporter en premier : GitLab auto-hébergé seul, ou GitHub aussi dès l'étape 2 ?
- Modèles d'environnement prioritaires : quelles stacks (PHP et versions, Node, bases de données) ?
- Clé API : une clé d'entreprise commune avec suivi par utilisateur, ou chaque utilisateur avec sa propre clé ?
- Tickets internes : besoin réel à court terme, ou étape lointaine ?
- Support : durée exacte de conservation de la table de correspondance et des diagnostics, avis du DPO, AIPD à mener.
- Support : conditions de conservation et d'entraînement du fournisseur selon le mode (abonnement, API, offre Team ou Entreprise).
- Dépôts de paquets privés : quel mécanisme pour fournir un jeton en lecture seule à la construction de l'image ?
