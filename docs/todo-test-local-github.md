# Todo : essayer l'outil en local sur un repo GitHub existant

Pour toi, environ 45 minutes. L'outil tourne dans WSL (`~/review-agent`) et reste indépendant de ton travail sur timelog : il clone le dépôt dans `~/review-agent/data/`, ne touche jamais à ton dossier de travail, et ne pousse que sur des branches `feature/<n>-...`. Tu peux donc continuer timelog en parallèle.

Je ne peux pas faire à ta place : créer le jeton, modifier le `.env`, cliquer dans le dashboard. Si quelque chose casse, envoie-moi le message exact (jamais le jeton).

## A. Le dépôt (5 min, sur GitHub)

- [ ] Choisir le dépôt : timelog s'il est sur GitHub (privé de préférence), sinon un autre.
- [ ] Créer une **petite issue de test assignée à toi**, sans toucher au code, par exemple « Test review-agent : ajouter une ligne dans le README ».
- [ ] Pour l'étape F : une branche `test/review-agent` avec une petite modification, et une **PR** vers la branche principale.

## B. Le jeton GitHub (5 min)

- [ ] GitHub > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate new token.
- [ ] Repository access : **Only select repositories**, uniquement le dépôt de test.
- [ ] Permissions : Contents, Pull requests et Issues en **lecture et écriture** ; Checks et Commit statuses en **lecture** (Metadata est ajoutée seule).
- [ ] Expiration courte (30 jours).
- [ ] Le mettre dans `~/review-agent/.env` : `GITHUB_TOKEN=...` (**tu le fais toi-même**, je n'y touche pas). C'est le plus simple : l'étape F (`review:once`) ne lit que le `.env`, pas le coffre du dashboard. Puis redémarrer l'outil (Ctrl+C dans son terminal, puis `npm run dev` dans `~/review-agent`).
- [ ] Ne jamais coller le jeton dans le chat.

## C. Vérifier dans le dashboard (5 min)

- [ ] http://localhost:4321 > Paramètres > Connexion : une ligne **GitHub** avec ton identifiant `@...`.
- [ ] Onglet Tickets : l'issue de test apparaît avec l'étiquette GitHub et un numéro `#N` (pas `!N`).
- [ ] Paramètres > Projets > **Ajouter un projet** > forge GitHub > rechercher le dépôt. Cocher « Autoriser l'agent dev », branche de départ = la branche principale (ex. `main`), branche cible = la même. **Commandes autorisées : vide** pour ce premier essai (l'agent le dira dans son rapport). Enregistrer.

## D. L'agent dev (10 à 15 min, consomme ton quota d'abonnement)

- [ ] Onglet Tickets : lancer l'agent sur l'issue de test, suivre le journal en direct.
- [ ] Il démarre et produit un résultat comme avant : c'est la vérification que l'environnement filtré des agents ne casse rien (`docs/a-tester.md`, section 7).
- [ ] Sur GitHub : une branche `feature/<n>-...` est poussée, une PR **Draft** est ouverte, un commentaire est posé sur l'issue. Aucune autre branche n'est touchée.
- [ ] La PR ne contient que ce qui était demandé.
- [ ] Facultatif : « reprise » avec une consigne : un nouveau commit sur la même branche, sans réécriture d'historique.
- [ ] **Nettoyage** : fermer la PR Draft et supprimer la branche `feature/...` (l'outil ne supprime jamais rien).

## E. Le journal (2 min)

- [ ] Paramètres > Journal des actions : lignes « Branche poussée », « Demande de fusion créée », avec le dépôt et « ok » en vert.

## F. La review (10 min)

Un compte seul ne peut pas être relecteur demandé de sa propre PR, donc on passe par la ligne de commande (mode ombre : rien n'est posté).

- [ ] `cd ~/review-agent && npm run review:once -- <url de la PR de test>` : le résultat s'affiche et apparaît dans l'onglet Reviews.
- [ ] Dans la review, le bouton de publication du commentaire (après avoir choisi un mode d'action autre que « ombre » si besoin) pose un commentaire de review sur la PR.
- [ ] L'approbation de ta propre PR sera refusée par GitHub : c'est normal avec un seul compte.
- [ ] **Nettoyage** : fermer la PR de test.

## G. Ensuite

- [ ] Me dire ce qui a marché et ce qui a cassé. Pour le VPS, on enchaîne avec `docs/deploiement.md` (sections 1 à 8).
