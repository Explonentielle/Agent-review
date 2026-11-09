# review-agent

Outil local (WSL) qui pilote Claude Code sur le travail GitLab : tickets assignés, agent dev (ticket vers MR Draft) et review des MR des collègues. Le support Planio arrivera ensuite. Il n'est pas déployé : chaque utilisateur le clone et le configure pour lui.

## Repères

- Fonctionnement, sécurité et choix techniques : `docs/architecture.md`.
- Backlog : `docs/roadmap.md`. Quand un item est terminé, mets à jour sa ligne dans le tableau « Vue d'ensemble » et ajoute un paragraphe **Implémenté (date)** dans sa section : ce qui a été fait, où, ce qui a été testé, les limites connues.
- Node 24, TypeScript strict, ESM (`NodeNext` : imports relatifs en `.js`), exécution via `tsx`.
- Base SQLite locale (`data/`, non versionnée) : les migrations sont dans le tableau `MIGRATIONS` de `src/db/index.ts`, appliquées au démarrage. Ne jamais modifier une migration déjà appliquée : en ajouter une à la fin.
- Cible à long terme (plateforme hébergée, conteneur par utilisateur) : `docs/vision-plateforme.md` et `docs/parcours-utilisateur.md`. Spec seulement, rien n'est implémenté. Les décisions de sécurité qui y sont prises (patch seul hors du conteneur, caviardage des données clients avant tout prompt) s'appliquent à toute évolution vers cette cible.

## Commandes

- `npm run typecheck` et `npm test` avant de considérer une modification terminée.
- `npm run review:once -- <url de la MR>` pour tester une review sans rien poster.
- `bash scripts/smoke-claude.sh` et `npx tsx scripts/smoke-dev.ts` après toute modification des options de la CLI `claude` (tests réels, quelques centimes de quota).
- Dans WSL, lancer `npm` et `npx` depuis un shell qui a le Node de WSL dans son PATH (`bash -lc`), sinon c'est le npm de Windows qui répond.
- `tsx watch` ne voit pas toujours les fichiers modifiés depuis Windows : après un changement de code serveur, vérifier que le serveur a bien redémarré (heure du processus) et sinon le relancer à la main. Ne pas modifier le code serveur pendant qu'une tâche d'agent tourne : le redémarrage la coupe.

## Règles du projet

- Code et textes en français pour les messages, logs et commentaires. Identifiants en anglais.
- Rien en dur qui dépende de l'utilisateur, de l'entreprise ou du projet (URL internes, noms de projets, labels, stacks, consignes) : URL et token dans le `.env`, tout le reste dans les réglages du dashboard (`src/settings/`), validés par zod côté serveur. Les prompts `prompts/*-system.md` restent génériques : ce sont les valeurs par défaut, remplaçables dans Paramètres > Prompts de base. Les consignes perso vont dans Paramètres > Consignes des agents.
- Les garde-fous des prompts (`prompts/*-guardrails.md` : anti-injection, ticket non autoritaire, pas de commit ni de push par l'agent, format de réponse) sont toujours ajoutés en dernier par `src/prompts.ts` et ne doivent jamais devenir modifiables depuis le dashboard.
- Les décisions d'agir (commenter, approuver, pousser, créer une MR, répondre à un client) restent dans du code déterministe et testé, jamais dans la sortie du modèle seule.
- **Push** : uniquement la branche créée pour le ticket, via `assertBranchAllowed` (`src/dev/guard.ts`), sans `--force`, MR toujours en Draft. Ne jamais affaiblir ces garde-fous sans demande explicite.
- **Reprise d'une MR** (`runFollowup`, `src/dev/pipeline.ts`) : même branche, nouveau commit poussé en fast-forward, jamais de `--force`. Elle refuse d'écraser un dossier de travail contenant des modifications ou des commits non poussés. Tout changement de ce flux se teste avec le test d'intégration git local (`src/review/workspace.test.ts`).
- **Agent dev sur un dépôt en ISO-8859-1 (ex. sra-moteur)** : interdit tant que la roadmap, item 35, n'est pas traité (les outils d'édition corrompent les accents).
- Les agents passent par la CLI `claude -p` sur l'abonnement de l'utilisateur, pas par le SDK avec une clé API (roadmap, items 3 et 25). Modèle plafonné à `claude-sonnet-5-5` en effort `high` : ne jamais relever ce plafond sans demande explicite.
- Droits des agents :
  - review : lecture seule ;
  - dev : lecture/écriture du worktree, git en lecture, commandes autorisées du projet ;
  - les deux : `--safe-mode`, `--strict-mcp-config`, `dontAsk`, pas de réseau.

  Tout élargissement de ces droits doit être discuté avant.
- Tout contenu venant de GitLab ou Planio (descriptions, tickets, commits, sortie du modèle) est non fiable : il est balisé dans les prompts et échappé dans le dashboard.
- Ne jamais lire ni modifier le `.env`. La configuration attendue est documentée dans `.env.example`.
- Git : ne jamais push ce dépôt sans demande explicite dans le même message, pas de trailer `Co-Authored-By`. Pas d'action réelle sur GitLab ou Planio (commentaire, approbation, push, MR) pendant le développement sans accord : tester avec `review:once` ou un dépôt local.
- « Note dans le backlog » : documenter l'item dans la roadmap, sans rien implémenter avant le feu vert.
- Rédaction : pas de tiret cadratin (utiliser points, virgules, deux-points).

## Méthode de travail (inspirée du Spec-Driven Development)

Le niveau de cérémonie dépend de la taille du changement :

- **Petit fix ou changement bien cadré** : coder directement, puis typecheck, tests et résumé.
- **Fonctionnalité moyenne ou grosse** (nouvelle action sur GitLab, nouveaux droits d'agent, nouvelle table, nouveau flux) : suivre ces étapes avant de coder.

1. **Spécifier** : reformuler le besoin en *quoi* et *pourquoi* (déclencheur, cas nominal, cas limites), sans parler technique.
2. **Clarifier** : lister les zones floues et poser les questions avant de coder. Ne jamais deviner une règle de workflow (labels, branches cibles, quand approuver) : la noter « à trancher » dans la roadmap.
3. **Planifier** : fichiers touchés, migration éventuelle (`src/db/index.ts`), réglages à exposer dans le dashboard, impact sur les garde-fous.
4. **Découper** en tâches courtes et vérifiables une par une.
5. **Analyser** : relire spec, plan et tâches ensemble (rien d'oublié, rien de hors-scope, aucun garde-fou affaibli).
6. **Implémenter et vérifier** : tests sur la logique pure et les garde-fous, test d'intégration git local pour tout ce qui pousse, smoke tests si les options `claude` changent.
7. **Documenter** : roadmap (« Implémenté (date) ») et `docs/architecture.md` si le flux change. Dire honnêtement ce qui n'a pas été testé contre le vrai GitLab.

Même logique pour les agents de l'outil : un ticket trop flou doit faire répondre l'agent dev en `blocked` avec ses questions, plutôt que coder au hasard.
