# review-agent

Outil local qui pilote Claude Code sur tes tickets GitLab ou GitHub :

- **Tickets** : tes tickets assignés, rangés par statut (à traiter, en cours, validation technique).
- **Agent dev** : sur un clic, un agent lit le ticket, crée la branche, code, puis l'outil pousse la branche et ouvre une **MR Draft**. Tu la contrôles avant de la passer en Ready.
- **Reviews** : les MR où tu es reviewer sont analysées automatiquement. Seul ce qui demande ton avis remonte.

Pour aller plus loin :
- Fonctionnement et sécurité : [docs/architecture.md](docs/architecture.md)
- Backlog : [docs/roadmap.md](docs/roadmap.md)

## Installation (WSL / Linux)

Prérequis : Node 24, git, un abonnement Claude (Pro ou Max) et un accès GitLab et/ou GitHub.

```bash
# 1. Node 24 (si absent)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc && nvm install 24

# 2. CLI Claude Code, connectée à ton abonnement
curl -fsSL https://claude.ai/install.sh | bash
~/.local/bin/claude          # puis /login, une seule fois
~/.local/bin/claude auth status --text

# 3. Le projet
git clone <url-du-repo> review-agent && cd review-agent
npm install
npm test

# 4. Configuration de la machine
cp .env.example .env         # remplir GITLAB_URL, GITLAB_TOKEN, GITLAB_USERNAME et/ou GITHUB_TOKEN
```

Ensuite, lance `npm run dev` et ouvre **http://localhost:4321/#settings** pour configurer :
1. **Workflow des tickets** : les labels de tes statuts (les labels de tes tickets sont proposés en un clic).
2. **Projets de l'agent dev** : pour chaque projet, branche de départ, branche cible de la MR, commandes de test autorisées et consignes propres au projet.
3. **Conventions** : formats de branche, de commit et de MR (avec un aperçu).
4. **Mode d'action** des reviews : garde le mode ombre au début.

## Utilisation

```bash
npm run dev                                   # poller + dashboard sur http://localhost:4321
npm run review:once -- <url de la MR>         # review manuelle d'une MR, rien n'est posté
```

## Garde-fous de l'agent dev

- Il ne pousse **que** la branche qu'il crée pour le ticket. Les branches de base et cible, les branches protégées GitLab et les branches partagées (`master`, `develop`, `global`, `release/*`...) sont refusées par le code.
- C'est l'outil qui commit et pousse, jamais l'agent. Aucun `--force`, MR toujours en **Draft**.
- L'agent n'a pas d'accès réseau. Il ne peut lancer que les commandes autorisées pour le projet, et ne voit ni hooks ni serveurs MCP du dépôt.
- Les fichiers de secrets (`.env`, clés) bloquent le push. Les fichiers de CI, Docker et dépendances sont signalés en tête de MR.

## Vérifications après une mise à jour de Claude Code

```bash
npm test                          # 26 tests, dont un test d'intégration git
npx tsx scripts/smoke-review.ts   # review via CliRunner + isolation (hook piégé non exécuté)
npx tsx scripts/smoke-dev.ts      # agent dev réel sur un dépôt jetable (Haiku, quelques centimes)
```

## Personnaliser les agents

- `prompts/review-system.md` et `prompts/dev-system.md` : prompts de base par défaut, remplaçables dans Paramètres > Prompts de base.
- `prompts/review-guardrails.md` et `prompts/dev-guardrails.md` : règles de sécurité, toujours ajoutées à la fin, non modifiables depuis le dashboard.
- Tes consignes (stacks, points d'attention, ce qu'il ne faut pas remonter) : dashboard, Paramètres > Consignes des agents. Celles d'un projet : Paramètres > Projets.
- Consignes par projet : dans le dashboard (Paramètres > Projets).

Ces fichiers sont relus à chaque exécution : pas besoin de redémarrer.
