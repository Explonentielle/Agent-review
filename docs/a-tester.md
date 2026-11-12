# À tester en rentrant

Mis à jour le 2026-11-11. Chaque ligne dit quoi faire et ce qu'on doit voir. Les cases à cocher sont pour toi. Tout ce qui est écrit ici a des tests automatiques (339), mais **aucun n'a été essayé sur un vrai compte ni dans un vrai navigateur** : c'est ce qu'il reste à vérifier.

**Ordre conseillé ce soir** : sections 0, puis 7 (les agents tournent-ils encore ? c'est le seul vrai risque de régression), puis 1 et 2 (GitHub), 3, 9. Les sections 5, 6 et 8 sont facultatives : elles ne changent rien tant que tu ne mets pas les variables `AUTH_*` ou que tu ne déploies pas.

## 0. Avant tout

- [ ] **Sauvegarder `data/master.key`** (dans `~/review-agent/data/`) ailleurs que sur la machine : sans ce fichier, les jetons enregistrés dans le dashboard sont perdus, et l'outil refuse de démarrer plutôt que d'en recréer un. Ne jamais le versionner ni l'envoyer.
- [ ] Le serveur tourne toujours (`npm run dev` dans `~/review-agent`) : ouvrir http://localhost:4321 et vérifier que les onglets Reviews, Tickets, Agent dev et Paramètres s'affichent avec tes données d'avant (5 reviews, 2 tâches, 2 projets).
- [ ] Quand tout te semble en ordre, supprimer `data/backup-avant-c4.sqlite` (copie de la base d'avant la migration C4).

## 1. Jetons saisis dans le dashboard (C3)

Paramètres > Connexion > « Jetons enregistrés dans l'outil ».

- [ ] La section s'affiche : trois lignes (Jeton GitLab « défini dans le .env (prioritaire) » sans champ, Jeton GitHub et Clé API Anthropic avec une pastille « non défini » orange, un champ mot de passe et un bouton Enregistrer). Aucun style cassé.
- [ ] Coller un jeton GitHub invalide puis Enregistrer : un message d'erreur rouge de GitHub s'affiche et **rien n'est enregistré** (la pastille reste « non défini »).
- [ ] Coller un jeton GitHub valide (voir section 2) : message « Enregistré, chiffré et appliqué » **sans redémarrage**, pastille verte « enregistré, chiffré le <date> », bouton Supprimer apparu. La valeur n'est affichée nulle part.
- [ ] Appuyer sur Entrée dans le champ du jeton **n'enregistre pas** le formulaire des paramètres (seulement le jeton).
- [ ] Modifier un champ des paramètres (par exemple le budget) **sans l'enregistrer**, puis enregistrer un jeton : ta modification en cours n'est pas perdue.
- [ ] La forge GitHub apparaît tout de suite (étiquettes « GitLab » et « GitHub » sur les cartes après rechargement de l'onglet Tickets, sélecteur de forge dans l'éditeur de projet). Dans `data/logs/<date>.jsonl`, aucune ligne ne contient le jeton (chercher quelques caractères du jeton avec `grep`).
- [ ] Supprimer le jeton : confirmation, pastille « non défini », GitHub disparaît tout de suite.
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
- [ ] Déclenchement automatique des reviews : j'ai ajouté le réglage (section 10) avec « Toutes » par défaut, donc rien ne change tant que tu ne le modifies pas. Est-ce que « Toutes » reste le bon défaut pour toi ?

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

## 6. Plusieurs personnes (seulement si tu ouvres à ton collègue)

Fermé par défaut : sans `AUTH_ALLOWED_USERS`, tu es seul. À n'essayer qu'avec la connexion OAuth (section 5) et une personne de confiance : les agents partagent la machine et l'utilisateur système (voir le risque dans `docs/roadmap-plateforme.md`, C8).

- [ ] Ajouter `AUTH_ALLOWED_USERS=gitlab:<identifiant GitLab du collègue>` dans le `.env` (tu le fais toi-même), redémarrer. Le journal affiche `auth.enabled` avec `multiUser: true`.
- [ ] Le collègue ouvre l'adresse de l'outil et se connecte avec GitLab : il arrive sur un dashboard **vide** (aucune de tes reviews, tâches ou projets), son nom en haut, aucune forge (« Non configuré »).
- [ ] Il enregistre **son** jeton GitLab dans Paramètres > Connexion : message « Enregistré, chiffré et appliqué » **sans redémarrage**, ses tickets apparaissent dans l'onglet Tickets, avec son identifiant GitLab (pas le tien).
- [ ] De ton côté, rien ne change : tes tickets, tes reviews, ton identifiant ; ton jeton n'est pas utilisé pour lui (vérifier qu'une action faite par lui est à son nom sur GitLab).
- [ ] Il configure un projet et lance l'agent : la branche et la MR sont à son nom, dans son espace ; tu ne les vois pas dans ton onglet Agent dev.
- [ ] Lancer une review chez toi et une chez lui en même temps : l'une attend l'autre (`MAX_CONCURRENT_AGENTS=1`).
- [ ] Retirer son identifiant d'`AUTH_ALLOWED_USERS` et redémarrer : il est refusé à sa prochaine connexion.

## 7. Agents : environnement filtré (régression possible)

Les agents ne reçoivent plus tout l'environnement de l'outil, seulement PATH, HOME, la langue, les proxys et certificats, `XDG_*`, `CLAUDE_*` et `ANTHROPIC_*` (hors noms qui ressemblent à des secrets). Les tests passent et la CLI démarre avec un environnement minimal (`claude --version`), mais **aucune vraie exécution d'agent n'a eu lieu depuis ce changement**.

- [ ] Lancer l'agent dev sur un ticket, et une review : ils démarrent, lisent le dépôt, produisent un résultat comme avant (en mode abonnement, donc la connexion Claude passe toujours).
- [ ] Si les tests d'un projet (`allowedCommands`) échouent maintenant alors qu'ils passaient, une variable d'environnement qu'ils utilisaient n'est plus transmise : la lister, je l'ajoute à `AGENT_ENV_NAMES` dans `src/claude/process.ts`.

## 8. Déploiement sur le VPS (C9, jamais essayé)

Suivre `docs/deploiement.md`. À noter ce qui se passe réellement :
- [ ] `docker compose build` aboutit (durée, erreurs éventuelles de la CLI Claude Code ou de `npm ci`).
- [ ] `docker compose up -d` : `app` et `postgres` passent en `healthy`, le journal affiche `app.started`.
- [ ] Le tunnel SSH ouvre le dashboard ; `ss -tlnp | grep 4321` ne montre que `127.0.0.1`.
- [ ] `bash scripts/backup.sh` produit un fichier non vide ; `bash scripts/restore.sh <fichier> --yes` le recharge sur une pile d'essai.
- [ ] `free -h` avant et après : combien de mémoire reste-t-il avec rag-saas et la pile en marche ?

## 9. Journal des actions (C6)

- [ ] Paramètres > Journal des actions : la section s'affiche (vide au départ : « Aucune écriture sur une forge pour l'instant »).
- [ ] Après une vraie action de l'agent dev (branche poussée, MR créée, label posé) ou une publication de review (commentaire, approbation) : les lignes apparaissent avec la forge, la cible (`projet/numéro`) et « ok » en vert.
- [ ] Provoquer un échec (par exemple retirer un droit du jeton puis publier) : la ligne est en rouge « échec », le message d'erreur s'affiche au survol, et ne contient aucun jeton.
- [ ] Le texte des commentaires n'apparaît nulle part dans le journal (seulement leur longueur dans le détail de l'API).

## 10. Déclenchement des reviews

Paramètres > Déclenchement des reviews (trois choix, « Toutes » par défaut : rien ne change tant que tu n'y touches pas).

- [ ] La section s'affiche avec « Toutes » coché ; enregistrer les paramètres sans rien changer fonctionne comme avant.
- [ ] Choisir « À la main », enregistrer, attendre un cycle (90 s) : une MR où tu es relecteur apparaît dans Reviews avec le filtre **À lancer** (puce à part, avec son compteur), et l'agent ne démarre pas.
- [ ] Ouvrir cette review : l'encart « Pas encore analysée » et le bouton **Lancer la review** (à la place de « Relancer »). Cliquer : le statut passe à « En file » puis « En cours », le résultat arrive comme d'habitude.
- [ ] Un double clic rapide sur le bouton ne lance pas deux analyses.
- [ ] Redémarrer l'outil avec une review « À lancer » : elle y reste, aucune analyse ne démarre toute seule.
- [ ] Choisir « Projets configurés seulement » : une MR d'un projet absent de Paramètres > Projets n'apparaît pas du tout ; ajouter ce projet, elle apparaît au cycle suivant.
- [ ] Revenir à « Toutes » : les nouvelles MR repartent toutes seules (celles déjà « À lancer » attendent toujours ton clic).

## 11. Pas testé du tout

- Un vrai serveur PostgreSQL (pilote `pg`) : seuls SQLite et PostgreSQL embarqué (PGlite) sont testés. Lancer avec `TEST_DATABASE_URL` pour la suite complète.
- Le dashboard dans plusieurs navigateurs.
