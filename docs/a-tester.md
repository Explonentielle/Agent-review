# À tester en rentrant

Mis à jour le 2026-11-10. Chaque ligne dit quoi faire et ce qu'on doit voir. Les cases à cocher sont pour toi. Tout ce qui est écrit ici a des tests automatiques, mais **aucun n'a été essayé sur un vrai compte ni dans un vrai navigateur** : c'est ce qu'il reste à vérifier.

## 0. Avant tout

- [ ] **Sauvegarder `data/master.key`** (dans `~/review-agent/data/`) ailleurs que sur la machine : sans ce fichier, les jetons enregistrés dans le dashboard sont perdus, et l'outil refuse de démarrer plutôt que d'en recréer un. Ne jamais le versionner ni l'envoyer.
- [ ] Le serveur tourne toujours (`npm run dev` dans `~/review-agent`) : ouvrir http://localhost:4321 et vérifier que les onglets Reviews, Tickets, Agent dev et Paramètres s'affichent avec tes données d'avant (5 reviews, 2 tâches, 2 projets).
- [ ] Quand tout te semble en ordre, supprimer `data/backup-avant-c4.sqlite` (copie de la base d'avant la migration C4).

## 1. Jetons saisis dans le dashboard (C3)

Paramètres > Connexion > « Jetons enregistrés dans l'outil ».

- [ ] La section s'affiche : deux lignes (Jeton GitHub, Clé API Anthropic) avec une pastille « non défini » (orange), un champ mot de passe et un bouton Enregistrer. Aucun style cassé.
- [ ] Coller un jeton GitHub invalide puis Enregistrer : un message d'erreur rouge de GitHub s'affiche et **rien n'est enregistré** (la pastille reste « non défini »).
- [ ] Coller un jeton GitHub valide (voir section 2) : message « Enregistré, chiffré. Redémarre l'outil… », pastille verte « enregistré, chiffré le <date> », bouton Supprimer apparu. La valeur n'est affichée nulle part.
- [ ] Appuyer sur Entrée dans le champ du jeton **n'enregistre pas** le formulaire des paramètres (seulement le jeton).
- [ ] Modifier un champ des paramètres (par exemple le budget) **sans l'enregistrer**, puis enregistrer un jeton : ta modification en cours n'est pas perdue.
- [ ] Redémarrer l'outil : la forge GitHub apparaît (étiquettes « GitLab » et « GitHub » sur les cartes, sélecteur de forge dans l'éditeur de projet). Dans `data/logs/<date>.jsonl`, aucune ligne ne contient le jeton (chercher quelques caractères du jeton avec `grep`).
- [ ] Supprimer le jeton : confirmation, pastille « non défini ». GitHub disparaît au redémarrage suivant.
- [ ] Si `GITHUB_TOKEN` est dans le `.env`, la ligne affiche « défini dans le .env (prioritaire) » et n'a pas de champ de saisie.
- [ ] Clé API Anthropic : l'enregistrer, la pastille de Paramètres > Modèles passe à « clé définie » **sans redémarrage**. Passer en mode « Clé API Anthropic », lancer une review : elle démarre (validation réelle de A3, jamais faite). Vérifier le coût affiché et le budget mensuel.

## 2. GitHub pour de vrai (lot B)

Jamais essayé sur un vrai dépôt. Prérequis : un dépôt privé de test (un README, 2 ou 3 issues assignées à toi) et un jeton à portée fine limité à ce dépôt : Contents, Pull requests et Issues en lecture et écriture ; Checks et Commit statuses en lecture.

- [ ] Onglet Tickets : les issues assignées à toi apparaissent avec l'étiquette GitHub et le numéro `#12` (pas `!12`).
- [ ] Ajouter le projet GitHub dans Paramètres > Projets (choisir la forge GitHub), activer l'agent dev, renseigner les branches.
- [ ] Lancer l'agent sur une issue : une branche `feature/<n>-...` est poussée, une PR **Draft** s'ouvre, un commentaire est posé sur l'issue. Aucune autre branche n'est touchée.
- [ ] Le label de départ (réglé dans Workflow des tickets) est posé sur l'issue ; un label « Portée::valeur » remplace l'autre de la même portée.
- [ ] Reprendre la PR avec des consignes : un nouveau commit s'ajoute sans réécriture d'historique.
- [ ] Review : `npm run review:once -- <url de la PR>` (un compte seul ne peut pas être relecteur demandé de sa propre PR). Le résultat s'enregistre en base et apparaît dans l'onglet Reviews, rien n'est posté (mode ombre forcé).
- [ ] Mode « commentaire » puis « approbation » sur une PR de test : le commentaire est posé en review GitHub ; l'approbation est refusée si la tête de la PR a changé depuis la review.
- [ ] Limite connue à constater : une PR disparaît de « à reviewer » une fois la review soumise, tant que l'avis n'est pas redemandé.

## 3. GitLab (régression après les refactorings)

- [ ] Une vraie MR créée par l'agent n'a **pas** la case « Delete source branch when merge request is accepted » cochée (correctif du jour, jamais vérifié sur GitLab).
- [ ] Une review automatique de ton GitLab habituel fonctionne de bout en bout (détection par le poller, résultat, publication).

## 4. Questions pour toi

- [ ] Le bloc « Reprendre la main » (4 lignes dans `public/index.html`, fonction `showTask`) est-il à toi ? Il reste non commité.
- [ ] Déclenchement automatique des reviews : garder tel quel, ou ajouter un bouton de lancement manuel / limiter aux projets configurés ?

## 5. Connexion OAuth (C2), seulement si tu veux l'essayer

Dormante par défaut : sans les variables `AUTH_*` dans le `.env`, rien ne change. À essayer sur ton GitLab (`gitlab.speedmedia.fr`).

- [ ] Créer une application sur GitLab : Profil > Applications, nom libre, URL de retour `http://localhost:4321/auth/gitlab/callback`, **décocher « Confidential » seulement si GitLab le refuse**, portée `read_user` uniquement.
- [ ] Dans le `.env` (tu le fais toi-même) : `AUTH_GITLAB_CLIENT_ID`, `AUTH_GITLAB_CLIENT_SECRET`, `AUTH_OWNER=gitlab:<ton identifiant GitLab>`. Redémarrer l'outil. Le journal doit contenir `auth.enabled`.
- [ ] Ouvrir http://localhost:4321 : redirection vers la page de connexion, bouton « Se connecter avec GitLab ». Après l'accord chez GitLab, retour sur le dashboard avec **toutes tes données d'avant** (reviews, tâches, projets).
- [ ] Paramètres > Connexion : bloc « Session » avec ton nom ; « Se déconnecter » te ramène à la page de connexion, et http://localhost:4321/api/stats répond 401.
- [ ] Dans les outils du navigateur (Application > Cookies) : le cookie `ra_session` est HttpOnly et SameSite=Lax ; il n'est « Secure » qu'en https.
- [ ] Se connecter avec un autre compte GitLab : message « Ce compte n'est pas autorisé », aucune session.
- [ ] Une URL de retour mal saisie dans GitLab donne une erreur côté GitLab, pas une session.
- [ ] Revenir au mode sans connexion : retirer les variables `AUTH_*` du `.env` et redémarrer.

## 6. Pas testé du tout

- Un vrai serveur PostgreSQL (pilote `pg`) : seuls SQLite et PostgreSQL embarqué (PGlite) sont testés. Lancer avec `TEST_DATABASE_URL` pour la suite complète.
- Le dashboard dans plusieurs navigateurs.
