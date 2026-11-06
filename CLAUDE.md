# review-agent

Outil local (WSL) qui pilote Claude Code sur le travail GitLab : tickets assignés, agent dev (ticket vers MR Draft) et review des MR des collègues. Le support Planio arrivera ensuite. Il n'est pas déployé et n'a aucun lien de code avec `~/timelog`, dont il réutilise seulement des idées et le prompt.

## Repères

- Fonctionnement, sécurité et choix techniques : `docs/architecture.md`.
- Backlog : `docs/roadmap.md`. Quand un item est terminé, mets à jour sa ligne dans le tableau « Vue d'ensemble » et ajoute un paragraphe **Implémenté (date)** dans sa section : ce qui a été fait, où, ce qui a été testé, les limites connues.
- Node 24, TypeScript strict, ESM (`NodeNext` : imports relatifs en `.js`), exécution via `tsx`.

## Commandes

- `npm run typecheck` et `npm test` avant de considérer une modification terminée.
- `npm run review:once -- <url de la MR>` pour tester une review sans rien poster.
- `bash scripts/smoke-claude.sh` et `npx tsx scripts/smoke-dev.ts` après toute modification des options de la CLI `claude` (tests réels, quelques centimes de quota).

## Règles du projet

- Code et textes en français pour les messages, logs et commentaires. Identifiants en anglais.
- Rien en dur qui dépende de l'utilisateur ou du projet : secrets dans le `.env`, tout le reste dans les réglages du dashboard (`src/settings/`), validés par zod côté serveur.
- Les décisions d'agir (commenter, approuver, pousser, créer une MR, répondre à un client) restent dans du code déterministe et testé, jamais dans la sortie du modèle seule.
- **Push** : uniquement la branche créée pour le ticket, via `assertBranchAllowed` (`src/dev/guard.ts`), sans `--force`, MR toujours en Draft. Ne jamais affaiblir ces garde-fous sans demande explicite.
- Les agents passent par la CLI `claude -p` sur l'abonnement de l'utilisateur, pas par le SDK avec une clé API (roadmap, items 3 et 25). Modèle plafonné à `claude-sonnet-5-5` en effort `high` : ne jamais relever ce plafond sans demande explicite.
- Droits des agents :
  - review : lecture seule ;
  - dev : lecture/écriture du worktree, git en lecture, commandes autorisées du projet ;
  - les deux : `--safe-mode`, `--strict-mcp-config`, `dontAsk`, pas de réseau.

  Tout élargissement de ces droits doit être discuté avant.
- Tout contenu venant de GitLab ou Planio (descriptions, tickets, commits, sortie du modèle) est non fiable : il est balisé dans les prompts et échappé dans le dashboard.
- Ne jamais lire ni modifier le `.env`. La configuration attendue est documentée dans `.env.example`.
- Git : ne jamais push ce dépôt sans demande explicite dans le même message, pas de trailer `Co-Authored-By`. Pas d'action réelle sur GitLab ou Planio (commentaire, approbation, push, MR) pendant le développement sans accord : tester avec `review:once`, la démo ou un dépôt local.
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
