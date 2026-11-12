# Todo : essayer l'outil en local sur un repo GitHub existant

Pour toi, environ 45 minutes. L'outil tourne dans WSL (`~/review-agent`) et reste indépendant de ton travail sur timelog : il clone le dépôt dans `~/review-agent/data/`, ne touche jamais à ton dossier de travail, et ne pousse que sur des branches `feature/<n>-...`. Tu peux donc continuer timelog en parallèle.

Je ne peux pas faire à ta place : créer le jeton, modifier le `.env`, cliquer dans le dashboard. Si quelque chose casse, envoie-moi le message exact (jamais le jeton).

## A. Le dépôt (5 min, sur GitHub)

- [ ] Choisir le dépôt : timelog s'il est sur GitHub (privé de préférence), sinon un autre.
- [ ] Une issue **ouverte et assignée à toi** : sur la page de l'issue, colonne de droite, **Assignees > assign yourself**. Sans cela elle n'apparaît pas dans l'onglet Tickets (l'outil ne liste que les issues qui te sont assignées). Une petite issue vaut mieux pour un premier essai : « Gérer le SEO, sitemap etc. » est un vrai chantier (plus de tours d'agent, plus de quota), à garder pour après.
- [ ] **Rien à créer à la main pour la branche et la PR** : l'agent dev les crée lui-même (étape D), et cette PR sert ensuite à l'étape F. Pour en créer une toi-même, voir la section « Créer une branche et une PR à la main » en bas.

## B. Le jeton GitHub (5 min)

- [ ] GitHub > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate new token.
- [ ] Repository access : **Only select repositories**, uniquement le dépôt de test.
- [ ] Permissions : Contents, Pull requests et Issues en **lecture et écriture** ; Checks et Commit statuses en **lecture** (Metadata est ajoutée seule).
- [ ] Expiration courte (30 jours).
- [ ] Le mettre dans `~/review-agent/.env` : `GITHUB_TOKEN=...` (**tu le fais toi-même**, je n'y touche pas). C'est le plus simple : l'étape F (`review:once`) ne lit que le `.env`, pas le coffre du dashboard. Puis redémarrer l'outil (Ctrl+C dans son terminal, puis `npm run dev` dans `~/review-agent`).
- [ ] Ne jamais coller le jeton dans le chat.

## C. Vérifier dans le dashboard (5 min)

- [ ] http://localhost:4321 > Paramètres > Connexion : une ligne **GitHub** avec ton identifiant `@...`.
- [ ] Onglet Tickets : l'issue apparaît avec l'étiquette GitHub et un numéro `#N` (pas `!N`). Si elle n'y est pas : elle n'est pas assignée à toi, le jeton n'a pas accès à ce dépôt, ou l'outil n'a pas été relancé après l'ajout du jeton. Sa carte porte un bouton **Configurer le projet** : raccourci vers l'ajout du projet ci-dessous.
- [ ] Paramètres > Projets > **Ajouter un projet** > forge GitHub > rechercher le dépôt. Cocher « Autoriser l'agent dev », branche de départ = la branche principale (ex. `main`), branche cible = la même. **Commandes autorisées : vide** pour ce premier essai (l'agent le dira dans son rapport). Enregistrer.

## D. L'agent dev (10 à 15 min, consomme ton quota d'abonnement)

- [ ] Onglet Tickets : sur la carte de l'issue, bouton **Traiter avec l'agent** (il n'apparaît qu'une fois le projet configuré), confirmer, suivre le journal en direct. L'agent ne part **jamais tout seul** : il faut ce clic.
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

## Créer une branche et une PR à la main (si tu veux en avoir une à toi)

Par le site GitHub :
1. Page du dépôt > le sélecteur de branche (« main ») > taper un nom, par exemple `test/review-agent` > **Create branch**.
2. Ouvrir un fichier (README.md) > le crayon > modifier une ligne > **Commit changes**, en laissant « Commit directly to the `test/review-agent` branch ».
3. Retour sur la page du dépôt : bandeau jaune **Compare & pull request** > **Create pull request**.

Par le terminal, dans ton clone local du dépôt :
```
git switch -c test/review-agent
git commit -am "Test review-agent"
git push -u origin test/review-agent
```
`git switch -c` crée la branche et s'y place, `git commit -am` enregistre les fichiers déjà suivis que tu as modifiés (modifie-en un avant), `git push -u origin ...` l'envoie sur GitHub et relie ta branche locale à celle de GitHub. Git affiche ensuite un lien : ouvre-le et clique **Create pull request**.

## G. Ensuite

- [ ] Me dire ce qui a marché et ce qui a cassé. Pour le VPS, on enchaîne avec `docs/deploiement.md` (sections 1 à 8).
