# À tester en rentrant

Mis à jour le 2026-11-12. Chaque ligne dit quoi faire et ce qu'on doit voir. Les cases à cocher sont pour toi. Tout ce qui est écrit ici a des tests automatiques (390), mais **aucun n'a été essayé sur un vrai compte ni dans un vrai navigateur** : c'est ce qu'il reste à vérifier. Un parcours guidé pour GitHub en local : `docs/todo-test-local-github.md`.

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
- [ ] Filtre par forge (pastilles sous le titre, visibles dès que GitLab et GitHub sont connectés) : « Toutes » affiche tout ; « GitHub » ne montre que les tickets GitHub, « GitLab » que ceux de GitLab ; chaque pastille porte son compteur (qui suit le champ de recherche). Recharger la page : le choix est retenu. Taper dans la recherche garde le filtre actif.
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

- [x] Le bloc « Reprendre la main » (4 lignes de `showTask`) : il était à toi, retiré le 2026-11-12 sur ta demande.
- [x] Déclenchement automatique des reviews : « Toutes » reste le défaut (décidé le 2026-11-12).

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
- [ ] Import de ta base locale (section 5 bis de `docs/deploiement.md`) : la commande affiche les effectifs (ex. 5 reviews, 2 tâches, 2 projets), le dashboard du serveur montre tes données, tes jetons enregistrés restent lisibles si `SECRETS_MASTER_KEY` est la clé de `data/master.key`, et un second import est refusé (« base cible pas vide »).

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

## 11. Agents dans des conteneurs (lot D, facultatif)

Fermé par défaut (`AGENT_RUNTIME` absent = les agents tournent comme avant). À essayer sur ton poste, qui a Docker, avec une clé API de test.

- [ ] Construire l'image : `cd ~/review-agent && docker build -f Dockerfile.agent -t review-agent-sandbox:local .` (télécharge des paquets : plusieurs minutes ; ajoute `--build-arg AGENT_PACKAGES="php-cli php-mbstring php-xml unzip"` pour PHP). Vérifier `docker run --rm review-agent-sandbox:local claude --version`.
- [ ] Dans le `.env` (tu le fais toi-même) : `AGENT_RUNTIME=docker` (l'image par défaut est celle construite ci-dessus). Dans le dashboard : Paramètres > Modèles > mode **Clé API** (la clé enregistrée dans Connexion). Redémarrer l'outil.
- [ ] Paramètres > **Agents dans des conteneurs** : l'image, les plafonds et l'utilisateur du conteneur s'affichent (sans `AGENT_RUNTIME=docker` : une phrase explique que les agents tournent sur la machine, pas de bouton). Clique **Tester les conteneurs** : sept lignes avec une pastille verte (mode clé API, Docker, image, écriture, isolation, plafonds, CLI Claude Code), en quelques secondes. Sans l'image construite, la ligne « Image des agents » est rouge et donne la commande de construction ; en mode Abonnement, la ligne « Mode clé API » est rouge. Vérifier aussi que `docker ps -a` ne montre aucun conteneur `ra-diag-...` après le test.
- [ ] Image par projet : ajouter `AGENT_IMAGES=<une autre image déjà construite>` au `.env` (toi), redémarrer. Paramètres > Agents dans des conteneurs liste cette image et propose un bouton « Tester » par image. Paramètres > Projets > Modifier : la liste « Image de l'agent (conteneur) » propose l'image par défaut et les autres ; après enregistrement, la ligne du projet affiche « image ... ». Un nom d'image hors liste est refusé à l'enregistrement (message « non autorisée »). Une review sur ce projet lance un conteneur de cette image (`docker ps`).
- [ ] Lancer une review : pendant qu'elle tourne, `docker ps` montre un conteneur `ra-agent-...` ; à la fin, `docker ps -a` n'en montre plus. Le résultat est le même qu'avant.
- [ ] Vérifier l'isolation pendant une tâche : `docker exec <conteneur> env` ne contient ni `GITLAB_TOKEN`, ni `GITHUB_TOKEN`, ni `SECRETS_MASTER_KEY`, ni `DATABASE_URL` (seulement `ANTHROPIC_API_KEY` et `HOME`).
- [ ] Lancer l'agent dev sur un ticket : les fichiers modifiés t'appartiennent (pas root), la MR Draft est créée comme avant ; les tests du projet (`allowedCommands`) marchent **seulement si l'image contient leurs outils** (sinon : « command not found » : ajoute-les à l'image avec `AGENT_PACKAGES`, voir `docs/deploiement.md`, section 10).
- [ ] Annuler une tâche en cours depuis le dashboard : le conteneur disparaît.
- [ ] Repasser en mode Abonnement avec `AGENT_RUNTIME=docker` : la review échoue avec un message clair (« exige le mode clé API ») au lieu de partir sur la machine.
- [ ] Constater : la mémoire utilisée par un agent (`docker stats`) et le temps de démarrage du conteneur.

**Sur le VPS, avec Docker sans root** (`docs/deploiement.md`, section 11, décidée le 2026-11-12 : jamais essayée, c'est ici qu'elle se valide) :
- [ ] Suivre les étapes 1 à 9 de la section 11. Noter chaque erreur : les plus probables sont la restriction des espaces de noms utilisateur d'Ubuntu récent (étape 3), le plugin `docker compose` absent, et un `node` qui n'est pas dans `/usr/bin`.
- [ ] `docker info --format '{{.SecurityOptions}}'` contient `name=rootless` ; `docker run --rm --memory 64m alpine cat /sys/fs/cgroup/memory.max` affiche `67108864` (sinon les plafonds sont ignorés : le dire avant de continuer).
- [ ] Le bouton **Tester les conteneurs** (Paramètres > Agents dans des conteneurs) donne sept pastilles vertes. En cas de rouge, noter la ligne et son message : ils disent quoi corriger (délégation de cgroups, image, `AGENT_CONTAINER_USER`...).
- [ ] Une review en mode clé API fonctionne : l'agent écrit dans son dossier de travail (c'est le point que seul un vrai Docker sans root peut confirmer : conteneur en `0:0` = utilisateur `review`). Si l'agent échoue sur des droits d'écriture, noter le message exact.
- [ ] Les fichiers du dossier de travail appartiennent à `review`, pas à un UID étrange (`ls -ln` dans `data/`).
- [ ] La CLI Claude Code accepte de tourner en root du conteneur avec `--permission-mode dontAsk` (elle refuse seulement `--dangerously-skip-permissions` en root, que l'outil n'utilise pas) : à confirmer avec la vraie CLI.
- [ ] `ps` sur le VPS : l'outil et `dockerd` tournent sous `review`, pas sous root ; rag-saas est inchangé (`docker ps` avec le Docker de root).

## 11 bis. Terminal Claude, premiers pas et atelier (annexe A de la roadmap)

Essayé dans un vrai navigateur (Chrome sans fenêtre, sous Windows) avec un **faux programme** à la place de `claude` : ouverture du terminal, sortie en flux continu avec accents et caractères japonais, saisie et touche Entrée, pastille qui passe à « connecté », arrêt de la session, rendu de la page « La forge » (quatre forgerons, bulles, étincelles). **Jamais essayé avec la vraie CLI ni avec l'outil `script`, qui n'existe pas sous Windows.**

Sur le VPS (Linux) :
- [ ] `docker compose exec app which script` affiche un chemin. Sinon, le terminal le dit (« exige l'outil script ») : le dire avant de continuer.
- [ ] Paramètres > Connexion > Abonnement Claude : pastille « non connecté », puis **Ouvrir le terminal Claude** : la CLI s'affiche (choix du thème, puis de la connexion).
- [ ] Choisir la connexion avec ton compte Claude : un lien s'affiche. Il se lit entier malgré la largeur du terminal (sinon le copier avec la souris). L'ouvrir dans ton navigateur, se connecter, copier le code, le **coller** dans le terminal (Ctrl+Maj+V ou clic droit), Entrée.
- [ ] La pastille passe à « connecté » en moins de 10 s, avec un message « Claude est connecté ». `docker compose exec app claude auth status --text` le confirme.
- [ ] **Arrêter la session**, recharger la page, vérifier que la pastille reste « connecté » (la session est dans le volume), puis `docker compose restart app` : toujours connecté.
- [ ] Les flèches, Tab, Échap et Ctrl+C fonctionnent dans le terminal. Les couleurs et le cadre de la CLI ne sont pas déformés (taille fixe 100 x 30).
- [ ] Laisser le terminal ouvert sans rien taper 15 min : la session se ferme seule (`[Session terminée]`).
- [ ] Depuis un autre onglet, ouvrir la page avec un en-tête proxy (`curl -H 'X-Forwarded-For: 1.2.3.4' http://127.0.0.1:4321/api/terminal`) : refusé (403) tant que `AUTH_*` n'est pas configuré.
- [ ] Lancer une tâche de l'agent dev : elle tourne sur ton abonnement, sans erreur d'authentification.

La forge (onglet « La forge », monde 2D, voir roadmap Annexe B) :
- [ ] Premier passage : création du personnage, puis Maître Brann parle dans une forge vide. Marcher aux flèches ou ZQSD, cliquer pour aller quelque part, E pour parler. Aucun son tant que tu n'as pas cliqué sur Son ou Musique.
- [ ] Un fourneau (GitHub ou GitLab) ouvre une fenêtre avec les vrais champs de connexion ; enregistrer un jeton fait apparaître la forge et la quête suivante.
- [ ] La pierre d'éveil ouvre le bloc Claude et le terminal ; une fois connecté, l'apprenti apparaît.
- [ ] Le râtelier liste les projets (arme, type au choix, éditeur de projet dans la fenêtre) ; l'apprenti liste les tickets et « Forger » lance une vraie tâche ; le gardien montre les reviews.
- [ ] Pendant une tâche : un forgeron frappe l'enclume, sa bulle dit la dernière étape ; à la fin, la pièce apparaît chez le marchand, qui la rachète pour de l'or ; l'or sert à acheter une tenue.
- [ ] Tableau des quêtes, onglet « Aujourd'hui » : trois missions du jour, un coffre, trois missions de la semaine. Après une vraie action (lancer un ticket, forger une pièce, terminer une review), la barre avance, une bannière annonce la mission accomplie, un « ! » apparaît sur le tableau et « Réclamer » donne l'or une seule fois.
- [ ] Série : après du travail deux jours de suite, « Série N j » apparaît sous la barre de niveau ; le lendemain, avant d'avoir travaillé, elle clignote (« s'éteint à minuit ») ; un jour sans rien la remet à zéro mais garde le record.
- [ ] Onglets Maîtrises et Prestige : les paliers franchis donnent de l'XP (le niveau monte), le changement de rang déclenche une bannière, un halo autour du forgeron, un bonus d'or chez le marchand et des tenues offertes (rang requis grisé avant).
- [ ] **Salle d'exemple (la salle du trône)** : une porte magique violette apparaît dans le mur du fond de la forge (dès qu'une forge est allumée). La toucher : « Entrer » ; la salle s'affiche avec un fondu, le Roi, la Reine, deux gardes et Dame Elsa parlent, la bibliothèque et les fenêtres se lisent. La porte du bas ramène sous la porte magique. `npx tsx scripts/check-rooms.ts` affiche « OK throne ».
- [ ] **Salles et jeux créés par les personnes** : parler à l'Architecte, onglet Créer, décrire une salle avec un jeu (« un platformer avec des pièces et un drapeau »). Vérifier : la proposition apparaît avec « un robot a réussi à gagner ce niveau » ; Visiter, Jouer (flèches ou ZQSD, espace pour sauter, Échap) ; Garder en privé ; la quête « Dessiner ta première salle » s'accomplit (+40 XP). Onglet Mes salles : partager à l'équipe puis rendre privée. **Avec un deuxième compte du même espace** : la salle partagée apparaît dans l'onglet Équipe, la salle privée non, et il peut la visiter et y jouer. Avec le vrai agent Claude : tester une demande de platformer, un labyrinthe vu de dessus, une taverne sans jeu ; un niveau impossible doit être renvoyé à l'agent ou signalé par un avertissement.
- [ ] **Architecte et menu profil** : parler à l'Architecte (en bas à gauche de la forge) : son dialogue dit que le générateur arrive plus tard, puis sa fenêtre liste les étapes, les salles et le catalogue. Cliquer « Copier le modèle », le coller dans `public/rooms/ma-salle.json`, lancer `npx tsx scripts/check-rooms.ts`, redéployer : la porte magique apparaît. Casser volontairement le fichier : l'erreur s'affiche dans la fenêtre « À corriger ». Menu profil (touche P) : les cinq onglets gardent la même taille, l'équipement se voit à gauche, y compris sur un petit écran.
- [ ] **Pièces jointes** : lancer l'agent sur un ticket en collant une capture d'écran (Ctrl+V), en glissant un CSV et en cliquant « Joindre des fichiers » ; un `.exe` est refusé avec un message clair ; la page de la tâche liste les fichiers ; dans le journal du dossier de travail, `.ra-attachments/` disparaît après l'agent et la MR ne contient aucune capture. Avec le Scribe : joindre une maquette à un ticket, vérifier chez GitLab le lien dans la description (chez GitHub, seulement la mention « gardé pour l'agent »), puis confier ce ticket à l'apprenti : l'agent reçoit la maquette. Vérifier avec un vrai agent qu'il lit bien une image et un PDF.
- [ ] **Butin et sac** : forger une pièce, faire relire puis fusionner une pièce : des objets tombent (bannière « Butin : … »), avec une rareté. Ouvrir le profil (touche P ou clic sur la barre en haut à gauche), onglet Sac (touche I), sur un petit écran aussi : équiper une cape, un couvre-chef, un tablier, une arme (visible sur le personnage), voir l'origine (Obtenu, Acheté, Échangé). Onglet Échange : donner 3 objets de même rareté non portés, choisir 1 objet de la rareté au-dessus. Recharger la page : rien ne retombe deux fois.
- [ ] **Maître de fusion** : une pièce relue OK (CI verte) est proposée en fusion dans sa liste et dans son dialogue ; une pièce déjà fusionnée n'y figure plus ; au râtelier, le statut de chaque pièce est à jour sans recharger (relecture en cours, relue OK, fusionnée).
- [ ] **Relecture et fusion de la pièce** (sur un projet de test, jamais sur un dépôt qui compte au premier essai) : au râtelier, une pièce forgée a « Relire et fusionner ». La fenêtre dit « Pas encore relue » et la fusion est grisée avec la raison. « Faire relire par le Maître de fusion » : le Gardien relit (vraie review de l'agent), **rien n'est publié sur la MR**. Si la relecture est OK et la CI verte, « Fusionner dans <branche cible> » s'active ; après confirmation, la MR sort du brouillon et est fusionnée chez la forge (vérifier chez la forge), le journal d'audit contient `change_request_ready` et `change_request_merge`. Vérifier les refus : review qui demande l'analyse, nouveau commit poussé après la review (la review n'est plus « actuelle »), CI rouge, MR qui vise une autre branche. Droits : sans le droit de fusionner (branche protégée), le message dit quoi ajouter.
- [ ] **Échec d'un essai de l'agent** : au râtelier (ou chez l'Apprenti), un ticket dont la tâche a échoué affiche « Échec : » suivi de la cause, avec « Relancer » et « Supprimer l'essai ». Après un échec qui a laissé sa branche chez la forge sans MR, « Relancer » crée une branche avec le suffixe -2 (le journal le dit) au lieu de refuser. Une branche qui a déjà une MR reste refusée : utiliser « Reprendre la MR ». Dans l'app, la page d'une tâche terminée a « Relancer l'agent » et « Supprimer cette tâche » (rien n'est supprimé chez la forge).
- [ ] **Scribe, ticket** : parler au Scribe (visible dès qu'une forge est allumée), dicter une idée sur un projet du râtelier, « Rédiger avec le Scribe » : un brouillon s'affiche (titre, description, étiquettes, questions). Le corriger, « Créer le ticket » : il existe chez la forge, avec les bonnes étiquettes. Le Scribe montre d'abord le **rendu** du ticket (titres, cases à cocher) : rien n'est créé avant « Valider et créer ». Le journal d'audit (Paramètres) contient `ticket_create`.
- [ ] **Scribe, projet** : onglet « Nouveau projet », idée, brouillon, choix du groupe ou de ton espace, privé coché, premiers tickets décochables, « Créer le projet » : le projet et ses tickets existent chez la forge ; « Ajouter au râtelier » ouvre l'éditeur prérempli.
- [ ] **Droits du jeton** : avec un jeton sans le droit de créer (lecture seule, ou GitHub sans « Administration »), le Scribe affiche un message qui dit quel droit ajouter, et rien n'est créé. Le bloc « Quels droits donner au jeton ? » du fourneau et du Scribe est cohérent avec la forge.
- [ ] **Tickets d'un projet** : au râtelier, choisir une arme : ses tickets ouverts s'affichent avec leur colonne, l'état du travail de l'apprenti et « Forger » (si l'agent dev est autorisé). Un ticket créé par le Scribe y apparaît dans les 20 secondes.
- [ ] **Vraie CLI** : `npx tsx scripts/smoke-scribe.ts` (là où `claude` est installé) : options acceptées, brouillon lu, consigne piégée dans un titre non suivie.
- [ ] Recharger la page ou changer d'onglet puis revenir : la progression (nom, or, tenues) est conservée ; vider le stockage du navigateur la remet à zéro.

## 11 ter. Arène et caractéristiques (forge)

Après `git pull && docker compose up -d --build`, dans la forge (aucune migration, tout est dans le navigateur) :

- [ ] Une **herse de fer** apparaît dans le mur du bas, à droite (pas une porte violette), une fois la première arme posée au râtelier. Maître Brann t'y envoie.
- [ ] La herse mène à la salle de l'arène ; le **Maître d'armes** explique les règles, puis propose Combattre, Mes caractéristiques, Comment ça marche, Plus tard.
- [ ] **Profil > Combat** : un point par niveau à répartir (+ et −), plafonné au niveau, « Réinitialiser » ; l'arme et les tenues équipées ajoutent des points (arme : Force, cape : Agilité, tablier : Vitalité, couvre-chef : Chance).
- [ ] Un combat : Espace frappe, Maj roule, les bots arment leur coup (« ! » rouge). À la fin : or (plafond de 150 par jour) et record.
- [ ] **Chaque arme a son effet** (l'effet s'affiche en haut de Profil > Combat) : **dague** très rapide et très courte, chiffres dorés des critiques fréquents ; **lance** touche deux ennemis alignés ; **arc** tire vite et loin pour peu de dégâts ; **marteau** assomme et un anneau de sable secoue les ennemis autour de l'impact ; **bâton** teinte en bleu et ralentit ce qu'il touche ; **hache** balaie devant toi ; **épée** équilibrée. Dis-moi lesquelles sont trop faibles ou trop fortes.
- [ ] **Armes uniques et choix de l'arme** : ouvre l'arène (herse, en bas à droite de la forge) puis parle au Maître d'armes : « Combattre ». Sur l'écran d'introduction, une **rangée de pastilles** montre tes armes : flèches gauche et droite (ou un clic) changent l'arme, et les valeurs (PV, dégâts, coups par seconde, bonus) changent tout de suite. « Changer d'arme » chez le Maître d'armes, ou Profil (P) > **Armes**, montre le détail et la différence de dégâts par seconde. Deux armes du même nom doivent avoir des valeurs différentes (qualité du jet en pourcentage). Dis-moi si les fourchettes te semblent trop larges ou trop serrées.
- [ ] **Effets spéciaux des armes** : une arme rare a 1 effet, épique 2, légendaire 3 (lignes avec un petit losange dans la page Armes et sur l'écran d'introduction). **Brûlure** : des flammes sur l'ennemi et des chiffres orange qui continuent après le coup. **Foudre** : un trait lumineux entre deux ennemis proches. **Vol de vie** : des « +2 » verts sur toi. **Givre** : ennemi teinté de bleu. **Recul** et **Étourdissement** : l'ennemi part plus loin ou reste figé. Dis-moi lesquels sont trop forts ou trop faibles, ou s'il en manque (poison, saignement, bouclier...).
- [ ] **Nouveaux personnages** (forge, arène, aperçu du profil, sac) : plus petits, tête ronde, cheveux et visage, ceinture, bottes, style plus ancien Zelda. À regarder : les quatre directions en marchant (la jambe qui se lève, les bras qui balancent), les coiffes plus basses (couronne, casque, chapeau de mage, plume), la cape de dos et de profil, la barbe, les oreilles pointues du gobelin, l'arme tenue à la main (hache et marteau cachent un peu le visage de face). Dis-moi si c'est trop petit ou trop chargé.
- [ ] Changer d'onglet en plein combat ferme l'arène et rend le clavier.
- [ ] La porte de fer de la salle te ramène devant la herse.
- [ ] **Équilibrage** : trop facile ? trop dur ? dis-le, c'est quelques nombres dans `public/forge/combat.js`.

## 12. Pas testé du tout

- Un vrai serveur PostgreSQL (pilote `pg`) : seuls SQLite et PostgreSQL embarqué (PGlite) sont testés. Lancer avec `TEST_DATABASE_URL` pour la suite complète.
- Le dashboard dans plusieurs navigateurs.
