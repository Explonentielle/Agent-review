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

Dormante par défaut : sans les variables `AUTH_*` dans le `.env`, rien ne change (pas de session, pas de bouton « Se déconnecter »). Deux forges possibles, ensemble ou seules : GitHub (github.com) et GitLab (ton instance, `GITLAB_URL`). Section mise à jour le 2026-11-26 : variables relues dans `src/config.ts`, étapes GitHub ajoutées.

**Variables du `.env`** (tu les écris toi-même ; seules `PUBLIC_URL` et `AUTH_SIGNUP` ont une valeur par défaut) :

| Variable | Rôle |
|---|---|
| `PUBLIC_URL` | Adresse que voit ton navigateur, base de l'adresse de retour. Défaut `http://localhost:4321`. Avec le tunnel SSH du VPS : `http://localhost:4321` |
| `AUTH_GITHUB_CLIENT_ID` et `AUTH_GITHUB_CLIENT_SECRET` | Identifiant et secret de l'application OAuth GitHub : les deux ensemble, sinon l'outil refuse de démarrer |
| `AUTH_GITLAB_CLIENT_ID` et `AUTH_GITLAB_CLIENT_SECRET` | Idem pour GitLab, avec en plus `GITLAB_URL` |
| `AUTH_OWNER` | Propriétaire, **obligatoire** dès qu'une connexion est configurée : `github:<login>` ou `gitlab:<login>`, ou une adresse email (connexion par email, voir la section 11 quinquies). Il reprend le compte local avec toutes ses données à sa première connexion. Doit viser une forge configurée |
| `AUTH_ALLOWED_USERS` | Autres personnes admises, `forge:login` séparés par des virgules (ancien mode, voir la section 6) |
| `AUTH_SIGNUP` | `invite` (défaut) ou `open` |
| `AGENT_RUNTIME` | Ne doit pas valoir `host` : refusé au démarrage dès qu'une connexion est configurée |

**Adresse de retour** : `<PUBLIC_URL>/auth/<forge>/callback`, c'est-à-dire `http://localhost:4321/auth/github/callback` ou `http://localhost:4321/auth/gitlab/callback`. Elle doit être identique, au caractère près, dans la forge et dans `PUBLIC_URL`. Une application GitHub n'en accepte qu'une.

### GitHub

- [ ] Créer l'application : github.com > ta photo > Settings > Developer settings > OAuth Apps > **New OAuth App** (https://github.com/settings/developers). Application name libre, Homepage URL `http://localhost:4321`, Authorization callback URL `http://localhost:4321/auth/github/callback`, « Enable Device Flow » décoché. **Register application**.
- [ ] Sur la page de l'application : copier le **Client ID**, puis **Generate a new client secret** et copier le secret tout de suite (GitHub ne le réaffiche plus ; en cas de perte, en générer un autre). L'outil ne demande que le droit `read:user` (lire ton profil), jamais l'accès à tes dépôts.
- [ ] Dans le `.env` : `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`, `AUTH_OWNER=github:<ton login GitHub>` (celui de github.com/<login>, majuscules sans importance), `PUBLIC_URL`. Redémarrer l'outil (VPS : `systemctl --user restart review-agent`, qui annule les agents en cours). Le journal doit contenir `auth.enabled` ; une valeur invalide fait échouer le démarrage avec le message exact (`AUTH_OWNER est obligatoire...`, `AUTH_GITHUB_CLIENT_ID et AUTH_GITHUB_CLIENT_SECRET vont ensemble`...).

### GitLab (facultatif)

- [ ] Créer une application sur GitLab : Profil > Applications, nom libre, URL de retour `http://localhost:4321/auth/gitlab/callback`, **décocher « Confidential » seulement si GitLab le refuse**, portée `read_user` uniquement.
- [ ] Dans le `.env` : `AUTH_GITLAB_CLIENT_ID`, `AUTH_GITLAB_CLIENT_SECRET`, `GITLAB_URL`, `AUTH_OWNER=gitlab:<ton identifiant GitLab>`. Redémarrer l'outil.

### Vérifications (quelle que soit la forge)

- [ ] Ouvrir http://localhost:4321 : redirection vers la page de connexion, bouton « Se connecter avec GitHub » (ou GitLab). Après l'accord chez la forge, retour sur le dashboard avec **toutes tes données d'avant** (reviews, tâches, projets, plans).
- [ ] Paramètres > Connexion, tout en bas : bloc « Session » (« Connecté comme <ton nom> ») et bouton « Se déconnecter » qui te ramène à la page de connexion. Ensuite http://localhost:4321/api/stats répond 401 : c'est normal, les appels directs (`curl`) demandent désormais la session.
- [ ] Dans les outils du navigateur (Application > Cookies) : le cookie `ra_session` est HttpOnly et SameSite=Lax ; il n'est « Secure » qu'en https.
- [ ] Se connecter avec un autre compte de la forge : message « Ce compte n'est pas autorisé sur cette installation. », aucune session ; le journal contient `auth.refused`.
- [ ] Une adresse de retour mal saisie dans la forge donne une erreur côté forge, pas une session. Si la page de connexion affiche « La connexion a échoué. Réessaie. », la cause est dans le journal (`auth.failed`, avec le message d'erreur de la forge ou de l'outil).
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

## 8. Déploiement sur le VPS (C9)

**Mis à jour le 2026-11-26 : le VPS tourne avec la variante de la section 11 de `docs/deploiement.md`** (outil sous systemd, Docker sans root, en service depuis le 2026-11-23), pas avec la pile compose complète. Les cases ci-dessous (`docker compose build` et `up`) ne concernent que cette pile complète, jamais relancée depuis le 2026-11-19. Pour le VPS actuel, le test à faire est celui de l'étape 9 de cette section 11 : une vraie review dans un conteneur avec `docker ps` pendant la tâche, et `free -h`.

**Script de déploiement et sauvegarde automatique (préparés le 2026-11-27, jamais essayés)**, sur le VPS, session `review`, dans `~/review-agent` :
- [ ] `bash scripts/deploy.sh --dry-run` : affiche « Déjà à jour » ou les commits reçus, les fichiers modifiés et les étapes prévues, sans rien changer (`git status` reste propre, le service n'est pas redémarré).
- [ ] Avec un conteneur `ra-agent-*` en cours (`docker ps`), `bash scripts/deploy.sh` refuse et le dit ; `--force` passe outre.
- [ ] Un vrai `bash scripts/deploy.sh` sur un commit reçu : sauvegarde écrite dans `backups/`, compilation, redémarrage, ligne finale « Terminé ». Le dashboard répond et `docker ps` ne montre aucun agent.
- [ ] Retour arrière (à ne tenter que sur un commit de test qui casse volontairement la compilation) : le script revient à l'ancien commit, recompile, redémarre le service sur l'ancien code et sort en erreur.
- [ ] Minuteur : suivre « Sauvegarde automatique » de la section 11 de `docs/deploiement.md`. `systemctl --user start review-agent-backup.service` crée un fichier `.sql.gz` non vide, `list-timers` donne une échéance vers 3 h 30, et le lendemain matin un nouveau fichier est là.
- [ ] Une sauvegarde se restaure bien sur une pile d'essai (`scripts/restore.sh`, `docs/deploiement.md` section 11).

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

## 11. Agents dans des conteneurs (lot D, obligatoire dès qu'il y a des comptes)

Depuis le 2026-11-19, `docker` est le **défaut** (`AGENT_RUNTIME` absent = conteneurs) et `AGENT_RUNTIME=host` est refusé au démarrage dès qu'une connexion par compte est configurée. À essayer sur ton poste, qui a Docker : d'abord avec une clé API de test, puis avec ton jeton d'abonnement (rien de tout cela n'a encore été essayé avec la vraie CLI).

- [ ] Construire l'image : `cd ~/review-agent && docker build -f Dockerfile.agent -t review-agent-sandbox:local .` (télécharge des paquets : plusieurs minutes ; ajoute `--build-arg AGENT_PACKAGES="php-cli php-mbstring php-xml unzip"` pour PHP). Vérifier `docker run --rm review-agent-sandbox:local claude --version`.
- [ ] Dans le `.env` (tu le fais toi-même) : rien de requis (`docker` est le défaut ; l'image par défaut est celle construite ci-dessus). Dans le dashboard : Paramètres > Modèles > mode **Clé API** (la clé enregistrée dans Connexion). Redémarrer l'outil. Contrôle du refus : `AGENT_RUNTIME=host` avec `AUTH_*` renseigné fait échouer le démarrage avec « AGENT_RUNTIME=host est refusé » (à remettre ensuite).
- [ ] **Abonnement dans un conteneur** : sur ton poste, `claude setup-token`, copier le jeton affiché ; Paramètres > Connexion > « Jeton d'abonnement Claude » > Enregistrer (la pastille du mode Abonnement passe à « jeton défini ») ; Paramètres > Modèles > mode **Abonnement**. Lancer une review : `docker ps` montre un conteneur `ra-agent-...`, la review aboutit sur ton abonnement (pas de facturation à l'usage). Si la CLI répond « not logged in » ou demande un thème, noter le message exact : c'est le point que seule la vraie CLI peut confirmer (le jeton sans dossier personnel persistant).
- [ ] Le jeton ne fuit pas : `docker exec <conteneur> env` pendant la tâche contient `CLAUDE_CODE_OAUTH_TOKEN` (seul identifiant), `ps aux | grep "docker run"` sur la machine ne montre **pas** sa valeur, et rien dans le dashboard ni dans `data/logs` ne le contient. Avec un second compte sans jeton en mode Abonnement : sa review est refusée avec « lance claude setup-token » (il n'utilise jamais ton jeton).
- [ ] Paramètres > **Agents dans des conteneurs** : l'image, les plafonds et l'utilisateur du conteneur s'affichent (avec `AGENT_RUNTIME=host` sans comptes : une phrase explique que les agents tournent sur la machine, pas de bouton). Clique **Tester les conteneurs** : sept lignes avec une pastille verte (connexion à Claude, Docker, image, écriture, isolation, plafonds, CLI Claude Code), en quelques secondes. Sans l'image construite, la ligne « Image des agents » est rouge et donne la commande de construction ; en mode Abonnement sans jeton (ou en mode clé API sans clé), la ligne « Connexion à Claude » est rouge et dit quoi faire. Vérifier aussi que `docker ps -a` ne montre aucun conteneur `ra-diag-...` après le test.
- [ ] Image par projet : ajouter `AGENT_IMAGES=<une autre image déjà construite>` au `.env` (toi), redémarrer. Paramètres > Agents dans des conteneurs liste cette image et propose un bouton « Tester » par image. Paramètres > Projets > Modifier : la liste « Image de l'agent (conteneur) » propose l'image par défaut et les autres ; après enregistrement, la ligne du projet affiche « image ... ». Un nom d'image hors liste est refusé à l'enregistrement (message « non autorisée »). Une review sur ce projet lance un conteneur de cette image (`docker ps`).
- [ ] Lancer une review : pendant qu'elle tourne, `docker ps` montre un conteneur `ra-agent-...` ; à la fin, `docker ps -a` n'en montre plus. Le résultat est le même qu'avant.
- [ ] Vérifier l'isolation pendant une tâche : `docker exec <conteneur> env` ne contient ni `GITLAB_TOKEN`, ni `GITHUB_TOKEN`, ni `SECRETS_MASTER_KEY`, ni `DATABASE_URL` (seulement la clé API ou le jeton d'abonnement de la personne, et `HOME`).
- [ ] Lancer l'agent dev sur un ticket : les fichiers modifiés t'appartiennent (pas root), la MR Draft est créée comme avant ; les tests du projet (`allowedCommands`) marchent **seulement si l'image contient leurs outils** (sinon : « command not found » : ajoute-les à l'image avec `AGENT_PACKAGES`, voir `docs/deploiement.md`, section 10).
- [ ] Annuler une tâche en cours depuis le dashboard : le conteneur disparaît.
- [ ] Supprimer le jeton d'abonnement (Paramètres > Connexion > Supprimer) puis lancer une review en mode Abonnement : elle échoue avec un message clair (« claude setup-token ») au lieu de partir sur la machine.
- [ ] **Test réel du jeton** : coller un jeton volontairement faux (20 caractères au hasard) > Enregistrer : un message annonce le test, puis une pastille rouge « refusé par Anthropic » avec la marche à suivre. Coller le vrai jeton : pastille verte « accepté par Anthropic ». « Vérifier la connexion » relance le test (un second clic dans les dix secondes renvoie le même résultat sans nouvel appel). Supprimer le jeton efface la ligne de résultat. `docker ps` montre un conteneur `ra-agent-...` pendant quelques secondes.
- [ ] **Modèle et effort choisissables** (Paramètres > Modèles) : la liste propose Fable 5.2, Opus 5.5, Sonnet 5.5 (défaut), Haiku 5.5 et Haiku 4.5, et les efforts Faible à Maximum. Choisir Opus 5.5 + Très élevé, enregistrer, recharger : le choix est gardé. Lancer une review : elle tourne avec ce modèle (visible dans le journal). Remettre Sonnet 5.5 + Élevé.
- [ ] **Résultat périmé** : sur une review déjà réussie, casser le jeton puis cliquer « Relancer » : la page affiche l'erreur 401 et, en dessous, « Le résultat plus bas est celui du run précédent » avec la pastille « run précédent » ; la page de la pièce (tâche dev) dit la même chose et montre le message d'erreur.
- [ ] **Terminal en conteneur** (propriétaire) : Paramètres > Connexion > Abonnement Claude > Ouvrir le terminal Claude. Le texte annonce un conteneur jetable ; `docker ps` montre un conteneur `ra-term-...` ; la CLI s'ouvre connectée (jeton défini) ; « Arrêter la session » supprime le conteneur (`docker ps -a` ne le montre plus). Noter si la CLI affiche des écrans de premier lancement (thème, confiance du dossier) : la page d'accueil de la CLI avec un dossier personnel vide n'a pas été vue.
- [ ] Constater : la mémoire utilisée par un agent (`docker stats`) et le temps de démarrage du conteneur.

**Sur le VPS, avec Docker sans root** (`docs/deploiement.md`, section 11, décidée le 2026-11-12 : jamais essayée, c'est ici qu'elle se valide) :
- [ ] Suivre les étapes 1 à 9 de la section 11 (commencée le 2026-11-19, étapes 1 à 5 faites le 2026-11-20 : voir les journaux des deux essais dans `docs/deploiement.md` ; entrer dans le compte `review` par `sudo machinectl shell review@`, sans clé SSH, puis `cd ~/review-agent`). Noter chaque erreur : à l'étape 3, Ubuntu 26.04 a bloqué `rootlesskit` (profil AppArmor requis, procédure dans la doc) ; restent à essayer les étapes 6 à 9.
- [x] `docker info --format '{{.SecurityOptions}}'` contient `name=rootless` ; `docker run --rm --memory 64m alpine cat /sys/fs/cgroup/memory.max` affiche `67108864` (fait le 2026-11-20 : les deux sont conformes).
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
- [ ] Le râtelier liste les projets (arme, type fixé à la création du projet et non modifiable, éditeur de projet dans la fenêtre) ; l'apprenti liste les tickets et « Forger » lance une vraie tâche ; le gardien montre les reviews.
- [ ] Pendant une tâche : un forgeron frappe l'enclume, sa bulle dit la dernière étape ; à la fin, la pièce apparaît chez le marchand, qui la rachète pour de l'or ; l'or sert à acheter une tenue.
- [ ] Tableau des quêtes, onglet « Aujourd'hui » : trois missions du jour, un coffre, trois missions de la semaine. Après une vraie action (lancer un ticket, forger une pièce, terminer une review), la barre avance, une bannière annonce la mission accomplie, un « ! » apparaît sur le tableau et « Réclamer » donne l'or une seule fois.
- [ ] Série : après du travail deux jours de suite, « Série N j » apparaît sous la barre de niveau ; le lendemain, avant d'avoir travaillé, elle clignote (« s'éteint à minuit ») ; un jour sans rien la remet à zéro mais garde le record.
- [ ] Onglets Maîtrises et Prestige : les paliers franchis donnent de l'XP (le niveau monte), le changement de rang déclenche une bannière, un halo autour du forgeron, un bonus d'or chez le marchand et des tenues offertes (rang requis grisé avant).
- [ ] **Salle d'exemple (la salle du trône)** : une porte magique violette apparaît dans le mur du fond de la forge (dès qu'une forge est allumée). La toucher : « Entrer » ; la salle s'affiche avec un fondu, le Roi, la Reine, deux gardes et Dame Elsa parlent, la bibliothèque et les fenêtres se lisent. La porte du bas ramène sous la porte magique. `npx tsx scripts/check-rooms.ts` affiche « OK throne ».
- [ ] **Pièces jointes** : lancer l'agent sur un ticket en collant une capture d'écran (Ctrl+V), en glissant un CSV et en cliquant « Joindre des fichiers » ; un `.exe` est refusé avec un message clair ; la page de la tâche liste les fichiers ; dans le journal du dossier de travail, `.ra-attachments/` disparaît après l'agent et la MR ne contient aucune capture. Avec le Scribe : joindre une maquette à un ticket, vérifier chez GitLab le lien dans la description (chez GitHub, seulement la mention « gardé pour l'agent »), puis confier ce ticket à l'apprenti : l'agent reçoit la maquette. Vérifier avec un vrai agent qu'il lit bien une image et un PDF.
- [ ] **Butin et sac** : forger une pièce, faire relire puis fusionner une pièce : des objets tombent (bannière « Butin : … »), avec une rareté. Ouvrir le profil (touche P) puis l'onglet **Équipement** (touche I), sur un petit écran aussi : équiper une cape, un couvre-chef, un tablier, une arme (visible sur le personnage), voir l'origine (Obtenu, Acheté, Échangé). **Échange** : à l'**établi d'échange** de la forge (en haut à droite, près du marchand) : donner 3 objets de même rareté non portés, choisir 1 objet de la rareté au-dessus. Recharger la page : rien ne retombe deux fois.
- [ ] **Maître juré** : une pièce relue OK (CI verte) est proposée en fusion dans sa liste et dans son dialogue ; une pièce déjà fusionnée n'y figure plus ; au râtelier, le statut de chaque pièce est à jour sans recharger (relecture en cours, relue OK, fusionnée).
- [ ] **Relecture et fusion de la pièce** (sur un projet de test, jamais sur un dépôt qui compte au premier essai) : au râtelier, une pièce forgée a « Relire et fusionner ». La fenêtre dit « Pas encore relue » et la fusion est grisée avec la raison. « Faire relire par le Maître juré » : le Gardien relit (vraie review de l'agent), **rien n'est publié sur la MR**. Si la relecture est OK et la CI verte, « Fusionner dans <branche cible> » s'active ; après confirmation, la MR sort du brouillon et est fusionnée chez la forge (vérifier chez la forge), le journal d'audit contient `change_request_ready` et `change_request_merge`. Vérifier les refus : review qui demande l'analyse, nouveau commit poussé après la review (la review n'est plus « actuelle »), CI rouge, MR qui vise une autre branche. Droits : sans le droit de fusionner (branche protégée), le message dit quoi ajouter.
- [ ] **Flux complet dans le tableau de bord, sans la forge** (sur un projet de test) : « Mes tickets » > Nouveau ticket (Scribe) > le ticket apparaît > « Traiter avec l'agent » > la tâche s'ouvre > MR Draft créée > « Faire relire par l'agent de review » > si des points sont relevés, la case « Joindre la relecture du commit actuel (N points) » est cochée dans « Reprendre avec des consignes » > « Lancer la reprise » (ou « Corriger avec la relecture », qui ajoute tes consignes si tu en as écrit) > la tâche de reprise s'ouvre et l'agent travaille > nouveau commit : la carte du ticket montre « À relire (nouveau commit) » > relire > « Relue OK » > Fusionner > « MR fusionnée ». À chaque étape, la carte du ticket dans « Mes tickets » montre l'état de la MR et mène à la page de la tâche. Dans le journal de la reprise, vérifier que l'agent a bien reçu les points de la relecture (il dit dans son rapport ceux qu'il écarte).
- [ ] **Reprise sans la relecture** : décocher la case, écrire des consignes, « Lancer la reprise » : l'agent ne reçoit que les consignes et les commentaires publiés sur la MR (pas les points de la relecture lancée depuis la page de la tâche, qui ne publie rien).
- [ ] **De la review vers la tâche** : onglet Reviews, ouvrir la review d'une MR faite par l'agent dev : un bandeau « MR faite par l'agent dev » mène à sa tâche (relire, corriger, fusionner) ; la review de la MR d'un collègue n'a pas ce bandeau. Après une reprise échouée, le lien mène toujours à la tâche qui propose la relecture et la fusion.
- [ ] **Échec d'un essai de l'agent** : au râtelier (ou chez l'Apprenti), un ticket dont la tâche a échoué affiche « Échec : » suivi de la cause, avec « Relancer » et « Supprimer l'essai ». Après un échec qui a laissé sa branche chez la forge sans MR, « Relancer » crée une branche avec le suffixe -2 (le journal le dit) au lieu de refuser. Une branche qui a déjà une MR reste refusée : utiliser « Reprendre la MR ». Dans l'app, la page d'une tâche terminée a « Relancer l'agent » et « Supprimer cette tâche » (rien n'est supprimé chez la forge).
- [ ] **Scribe, ticket** (page du tableau de bord, indépendante du jeu) : « Mes tickets » > **Nouveau ticket** (ou l'adresse `#tickets/new`, ou le personnage du Scribe dans la forge qui y emmène). Choisir la forge et un projet configuré, dicter une idée, « Rédiger avec le Scribe » : un brouillon s'affiche (titre, description, étiquettes, questions). Le corriger, puis « Valider et créer » depuis le **rendu** (titres, cases à cocher) : rien n'est créé avant. Le ticket existe chez la forge, avec les bonnes étiquettes ; « Voir dans Mes tickets » l'y montre (il t'est assigné), prêt à être confié à l'agent. Le journal d'audit (Paramètres) contient `ticket_create`. **Avec la forge (jeu) éteinte**, rien ne change.
- [ ] **Scribe, projet** : onglet « Nouveau projet », idée, brouillon, choix du groupe ou de ton espace, privé coché, premiers tickets décochables, « Valider et créer le projet » : le projet et ses tickets existent chez la forge ; « Configurer ce projet pour l'agent » ouvre l'éditeur de projet prérempli dans les Paramètres.
- [ ] **Droits du jeton** : avec un jeton sans le droit de créer (lecture seule, ou GitHub sans « Administration »), le Scribe affiche un message qui dit quel droit ajouter, et rien n'est créé. Le bloc « Quels droits donner au jeton ? » du Scribe et celui du fourneau de la forge sont cohérents.
- [ ] **Forge (jeu) éteinte et rallumée** : Paramètres > « La forge (jeu) », décocher : l'onglet « La forge » disparaît tout de suite, `#forge` dans la barre d'adresse ramène aux tickets, et rien du jeu n'est chargé (onglet Réseau du navigateur : aucun `/forge/...`, aucun `/api/hero`). Recocher : l'onglet revient et le monde se recharge. Tickets, Scribe, agent dev, reviews et fusion marchent pareil dans les deux cas.
- [ ] **Type d'arme** : au râtelier, un projet qui n'a pas encore de type choisi montre les sept types (le type par défaut est coché) ; un clic demande confirmation puis le fixe pour de bon (les sept types disparaissent, le type choisi reste affiché). Le formulaire de projet des Paramètres n'a plus de champ « type d'arme ».
- [ ] **Tickets d'un projet** : au râtelier, choisir une arme : ses tickets ouverts s'affichent avec leur colonne, l'état du travail de l'apprenti et « Forger » (si l'agent dev est autorisé). Un ticket créé par le Scribe y apparaît dans les 20 secondes.
- [ ] **Vraie CLI** : `npx tsx scripts/smoke-scribe.ts` (là où `claude` est installé) : options acceptées, brouillon lu, consigne piégée dans un titre non suivie.
- [ ] Recharger la page ou changer d'onglet puis revenir : la progression (nom, or, tenues) est conservée ; vider le stockage du navigateur la remet à zéro.

## 11 quater. Équipe, invitations, rôles et limites par personne

Prérequis : la connexion par compte de forge est configurée (`AUTH_*`, section 5), avec deux comptes de forge réels : le tien (propriétaire) et un second (un autre compte GitHub ou GitLab, ou un collègue). Aucune migration à faire à la main : elles s'appliquent au démarrage.

- [ ] **Transformer l'espace en équipe** : Paramètres > Équipe. Ton espace est « personnel » : le bouton « Transformer en espace d'équipe » apparaît, avec l'explication « on n'invite que dans un espace d'équipe ». Après confirmation, tes projets, réglages, reviews et tâches sont toujours là, et le formulaire d'invitation apparaît.
- [ ] **Inviter** : rôle « Membre », un mot, et le compte de forge du second compte dans « Réservée à un compte ». « Créer le lien d'invitation » : le lien s'affiche **une seule fois** (copier). Fermer le bandeau : le lien n'est plus récupérable. L'invitation est dans « en attente », sans le lien.
- [ ] **Accepter** : dans une fenêtre privée, ouvrir le lien : la page dit qui invite, l'espace et le rôle (un texte saisi par un autre, comme `<b>x</b>`, s'affiche tel quel, sans mise en forme). « Accepter avec GitHub » (ou GitLab) : la personne arrive dans l'espace de l'équipe avec le bon rôle, **sans espace personnel** (pas de sélecteur d'espace s'il n'y en a qu'un), et voit la pastille de son rôle dans l'en-tête si ce n'est pas administrateur.
- [ ] **Lien à usage unique** : rouvrir le même lien (autre navigateur, ou après déconnexion) : « Cette invitation n'est plus valable ». Même réponse pour un lien révoqué ou expiré, et pour un lien inventé. Avec un autre compte de forge sur une invitation réservée : la connexion est refusée avec le message d'invitation, et le lien reste utilisable par le bon compte.
- [ ] **Rôles** : le second compte en **membre** : il lance l'agent sur un ticket, relit, fusionne ; Paramètres : tout est grisé sauf « Connexion » (ses jetons), avec le bandeau qui l'explique ; pas de section Équipe, pas de journal. En **lecteur** (tu changes son rôle dans Équipe : effet immédiat, sans reconnexion) : il lit, mais « Traiter avec l'agent » répond « Ton rôle (lecteur) ne permet pas cette action ». En administrateur : tout est permis.
- [ ] **Dernier administrateur** : essayer de te passer en membre ou de te retirer quand tu es le seul administrateur : refusé, avec le message.
- [ ] **Ses jetons ne sont pas les tiens** : le second compte enregistre son propre jeton (Connexion) : il ne voit que ses tickets, jamais les tiens, et ses reviews et tâches apparaissent dans les listes de l'espace.
- [ ] **Retirer un membre** : ses sessions sont fermées tout de suite (rechargement : retour à la connexion), il ne voit plus l'espace, ses jetons de cet espace sont effacés.
- [ ] **Changer d'espace** : une personne membre de deux espaces (son personnel et l'équipe) a un sélecteur dans l'en-tête ; le changement recharge la page avec les données de l'autre espace, et son rôle y est celui de cet espace.
- [ ] **Limites par personne** : Paramètres > Modèles, « Agents par jour et par personne » à 1, enregistrer. Le second compte lance un agent : OK ; un deuxième : refusé tout de suite avec « Tu as atteint ta limite de 1 agent par jour » (rien n'est créé). Dans Équipe, relever sa limite à 3 : ça repart. En mode clé API : budget mensuel par personne bas : l'agent est refusé une fois le budget atteint (la consommation de chaque personne est affichée dans Équipe).
- [ ] **Limitation des tentatives** : appuyer 31 fois sur « Se connecter avec ... » depuis la même adresse en moins de 10 minutes : la 31e répond « Trop de tentatives ». Derrière un proxy : avec `TRUST_PROXY=true`, deux visiteurs différents n'ont pas la même limite ; avec `false`, un en-tête `X-Forwarded-For` envoyé à la main ne contourne pas la limite.
- [ ] **Sans connexion par compte** (outil local) : Paramètres > Équipe montre l'équipe mais dit que les invitations demandent `AUTH_*` ; tout reste permis (utilisateur local administrateur).

## 11 quinquies. Compte par email, organisations et invitations par email

Prérequis : un compte Resend avec un **domaine vérifié** (enregistrements DNS), `RESEND_API_KEY` et `MAIL_FROM` dans le `.env` du VPS, `PUBLIC_URL` en https, et `AUTH_OWNER` (ton adresse email, ou une forge). Redémarrer l'outil : les migrations s'appliquent seules. Prévoir deux boîtes email que tu lis : la tienne et une seconde.

- [ ] **Les emails partent** : sur `/signup` (avec `AUTH_SIGNUP=open` pour ce test), donner la seconde adresse : un email arrive en quelques secondes, expéditeur `MAIL_FROM`, pas classé en courrier indésirable (sinon vérifier SPF et DKIM chez Resend). Le lien pointe vers `PUBLIC_URL`.
- [ ] **Inscription** : le lien ouvre « Choisis ton mot de passe » avec l'adresse en lecture seule. Un mot de passe trop court est refusé **sans brûler le lien** ; un bon mot de passe crée le compte, ouvre la session et donne un espace personnel dont tu es l'administrateur. Rouvrir le lien : « Ce lien n'est plus valable ».
- [ ] **Même réponse** : redemander l'inscription avec cette adresse (déjà inscrite) : la page répond comme pour une adresse neuve, mais l'email reçu dit « Tu as déjà un compte ». Une adresse jamais vue sur « Mot de passe oublié » : même réponse, aucun email.
- [ ] **Connexion** : bon mot de passe, session ouverte. Mauvais mot de passe et adresse inconnue : le même message. Après 10 essais ratés sur une adresse : « Trop d'essais », même avec le bon mot de passe, pendant 15 minutes.
- [ ] **Mot de passe oublié** : l'email arrive, le lien permet d'en choisir un nouveau, l'ancien ne marche plus, et une session ouverte dans un autre navigateur est fermée.
- [ ] **Propriétaire** : avec `AUTH_OWNER` = ton adresse et un `.env` sans forge, t'inscrire avec cette adresse : tu retrouves tes projets, réglages, reviews et tâches (le compte local est repris).
- [ ] **Créer une organisation** : le sélecteur d'espace de l'en-tête propose « + Nouvelle organisation » ; après création, tu es administrateur et l'espace actif est la nouvelle organisation, vide.
- [ ] **Inviter par email** : Paramètres > Équipe, l'adresse de la seconde boîte, rôle « Membre », « Envoyer l'invitation par email ». Le message « Invitation envoyée à ... » s'affiche, **aucun lien n'est montré**, l'invitation est « en attente » avec l'adresse. L'email reçu nomme l'organisation, la personne qui invite et le rôle.
- [ ] **Accepter sans compte** : le lien de l'email ouvre une page avec l'adresse imposée ; nom et mot de passe : la personne arrive dans l'organisation avec le bon rôle, et le sélecteur d'espace de l'en-tête lui montre aussi son espace personnel.
- [ ] **Accepter avec un compte** : inviter une adresse qui a déjà un compte : la page demande le mot de passe (« Me connecter et accepter ») ; déjà connecté avec ce compte, un bouton « Accepter » suffit ; connecté avec un autre compte, la page le dit et refuse.
- [ ] **Lien à usage unique** : rouvrir le lien après acceptation, après révocation, ou un lien inventé : même page « plus valable ».
- [ ] **Resend en panne** : mettre une fausse clé `RESEND_API_KEY`, inviter : message d'échec, et aucune invitation en attente. Remettre la bonne clé.
- [ ] **Sans Resend** (variables retirées) : plus de formulaire de mot de passe sur `/login`, `/signup` renvoie vers la connexion, et les invitations par lien marchent comme avant.
- [ ] **Nombre d'organisations** : en créer 11 : la onzième est refusée avec « c'est la limite ».


## 11 ter. Arène et caractéristiques (forge)

Après `git pull && docker compose up -d --build`, dans la forge (aucune migration, tout est dans le navigateur) :

- [ ] Une **herse de fer** apparaît dans le mur du bas, à droite (pas une porte violette), une fois la première arme posée au râtelier. Maître Brann t'y envoie.
- [ ] La herse mène à la salle de l'arène ; le **Maître d'armes** explique les règles, puis propose Combattre, Mes caractéristiques, Comment ça marche, Plus tard.
- [ ] **Profil** (touche P) : un point par niveau à répartir (+ et −), plafonné au niveau, « Réinitialiser » ; l'arme et les tenues équipées ajoutent des points (arme : Force, cape : Agilité, tablier : Vitalité, couvre-chef : Chance).
- [ ] Un combat : Espace frappe, Maj roule, les bots arment leur coup (« ! » rouge). À la fin : or (plafond de 150 par jour) et record.
- [ ] **Chaque arme a son effet** (l'effet s'affiche en haut de l'onglet Profil) : **dague** très rapide et très courte, chiffres dorés des critiques fréquents ; **lance** touche deux ennemis alignés ; **arc** tire vite et loin pour peu de dégâts ; **marteau** assomme et un anneau de sable secoue les ennemis autour de l'impact ; **bâton** teinte en bleu et ralentit ce qu'il touche ; **hache** balaie devant toi ; **épée** équilibrée. Dis-moi lesquelles sont trop faibles ou trop fortes.
- [ ] **Armes uniques et choix de l'arme** : ouvre l'arène (herse, en bas à droite de la forge) puis parle au Maître d'armes : « Combattre ». Sur l'écran d'introduction, une **rangée de pastilles** montre tes armes : flèches gauche et droite (ou un clic) changent l'arme, et les valeurs (PV, dégâts, coups par seconde, bonus) changent tout de suite. « Changer d'arme » chez le Maître d'armes, ou Profil > **Équipement** (touche I, filtre Arme), montre le détail et la différence de dégâts par seconde. Deux armes du même nom doivent avoir des valeurs différentes (qualité du jet en pourcentage). Dis-moi si les fourchettes te semblent trop larges ou trop serrées.
- [ ] **Effets spéciaux des armes** : une arme rare a 1 effet, épique 2, légendaire 3 (lignes avec un petit losange dans la page Armes et sur l'écran d'introduction). **Brûlure** : des flammes sur l'ennemi et des chiffres orange qui continuent après le coup. **Foudre** : un trait lumineux entre deux ennemis proches. **Vol de vie** : des « +2 » verts sur toi. **Givre** : ennemi teinté de bleu. **Recul** et **Étourdissement** : l'ennemi part plus loin ou reste figé. Dis-moi lesquels sont trop forts ou trop faibles, ou s'il en manque (poison, saignement, bouclier...).
- [ ] **Vagues sans fin** : l'arène ne s'arrête plus à la 5e vague. Après le Seigneur, des vagues de plus en plus nombreuses (HUD « Vague 7 »), un **boss toutes les 5 vagues** : Colosse de pierre (10), Archimage (15, il tire de loin et ne charge pas). Des **assassins** rapides apparaissent. Échap en plein combat bat en retraite : les vagues terminées donnent de l'or et un record. À tester avec l'arc (tenir à distance), la lance et la dague. Dis-moi si c'est trop dur ou trop facile, et à partir de quelle vague.
- [ ] **Salles plus détaillées et plus nettes** (forge, salle du trône, arène) : sol avec dalles variées, joints fins, quelques fissures ; murs en briques teintées avec un peu de mousse ; toiles d'araignée dans les coins du haut ; **lumière douce et vacillante** autour des torches, du four et du portail violet ; bords de la salle légèrement assombris ; tapis tissé. Dans l'arène : sable avec cercle d'honneur et épées croisées, palissade cerclée de fer, boucliers aux murs, quatre braziers, deux rangs de spectateurs qui lèvent les bras. Dis-moi si c'est assez net, trop sombre (vignette) ou trop chargé (fissures), et quels objets doivent recevoir le même soin.
- [ ] **Profil réorganisé** (touche P) : 4 onglets. **Profil** = caractéristiques (points à répartir, valeurs de combat, record de l'arène) puis Apparence (nom et couleurs, enregistrés par « Enregistrer et fermer ») ; **Équipement** = l'ancien Sac et les armes réunis, les armes s'équipent comme le reste ; **Progression** = les anciennes données du profil (niveau, XP, rang, or, série, collection, prestige) ; **Quêtes** inchangé. Plus d'onglets Armes, Échange ni Combat.
- [ ] **Établi d'échange** : meuble en haut à droite du hall (balance, pièces, gemmes). Parle-lui (E) : la fenêtre d'échange s'ouvre seule, sans onglets. Donne 3 objets de même rareté, reçois 1 objet de la rareté au-dessus (une arme reçue est tirée au sort).
- [ ] **Hall en coins dédiés** : **armurerie** en haut à gauche (râtelier, mannequin, armure, tapis de cuir, le Maître juré) ; **atelier** au centre (enclumes et apprentis sur le tapis rouge, braseros à l'entrée) ; **marché** en haut à droite (étal sur tapis rayé, établi d'échange) ; **scriptorium** en bas à gauche (table, plantes, coffre, tapis bleu) ; **entrée de l'arène** en bas à droite (tapis de sable, braseros de part et d'autre de la herse, mannequin). Le Scribe est près du tableau des quêtes. Vérifie que tout reste accessible et que rien ne se chevauche.
- [ ] **Salle du trône et salle de l'arène très décorées** : fontaines, braseros, armures, plantes, tapisseries, tapis de couleur, mannequins d'entraînement. Dis-moi ce qui est trop chargé ou ce qui manque.
- [ ] **Maître juré** (ex-Maître de fusion) : il valide la qualité des pièces forgées avant leur fusion. Dis-moi si le nom te convient (autres idées : Maître éprouveur, Maître poinçonneur).
- [ ] **Marchand** (étal en haut à droite) : section **Stock du jour** (4 armes uniques avec leurs valeurs, effets et qualité du jet, et des tenues) : achète une arme, elle entre dans l'onglet Équipement ; l'offre est marquée « Acheté ». Recharge la page : le stock est le même ; il change le lendemain (tu peux changer la date de ton ordinateur pour voir). Section **Vendre mes objets** : vends une cape, une arme : l'objet **disparaît de ton sac** (Profil > Équipement), l'or monte (40 % de la valeur, plus ton bonus de rang) ; un objet porté n'est pas proposé ; une arme épique ou légendaire demande confirmation. Les pièces forgées se vendent toujours plus bas.
- [ ] **Loader de fusion** : fusionne une pièce prête, par le dialogue du Maître juré (« Fusionner ») ou par « La pièce » : un voile « Fusion en cours… » avec une roue s'affiche jusqu'à la réponse de la forge, puis disparaît. Pareil sur le bouton « Fusionner » du tableau de bord.
- [ ] **Corriger avec la relecture** (sur un projet de test) : fais relire une pièce dont la relecture demande ton attention (« Des points à analyser »). Dans la forge (le Maître juré, « La pièce »), la fenêtre liste chaque point (bloquant, important, suggestion, emplacement, explication) et les questions. Écris éventuellement une consigne en plus, clique « Corriger avec la relecture » : un apprenti reprend la même branche, la fenêtre dit « Un apprenti reprend la pièce » et se met à jour seule. Ensuite : un nouveau commit sur la MR (avec un commentaire de reprise qui ne recopie pas la relecture), « Faire relire » la nouvelle version, puis « Fusionner ». Le tableau de bord (page de la tâche) montre les mêmes points et le même bouton. Vérifie que l'agent tient bien compte des points (et note ceux qu'il écarte dans son rapport).
- [ ] **Nouveaux personnages** (forge, arène, aperçu du profil, sac) : plus petits, tête ronde, cheveux et visage, ceinture, bottes, style plus ancien Zelda. À regarder : les quatre directions en marchant (la jambe qui se lève, les bras qui balancent), les coiffes plus basses (couronne, casque, chapeau de mage, plume), la cape de dos et de profil, la barbe, les oreilles pointues du gobelin, l'arme tenue à la main (hache et marteau cachent un peu le visage de face). Dis-moi si c'est trop petit ou trop chargé.
- [ ] Changer d'onglet en plein combat ferme l'arène et rend le clavier.
- [ ] La porte de fer de la salle te ramène devant la herse.
- [ ] **Équilibrage** : trop facile ? trop dur ? dis-le, c'est quelques nombres dans `public/forge/combat.js`.

## 11 sexies. Plans : attendre la fusion de la MR avant le ticket suivant (2026-11-27)

Prérequis : un projet configuré pour l'agent dev dont la branche de base et la branche cible sont **la même**, et un plan de deux tickets au moins. Les tests automatiques passent (1008), mais **aucun essai avec un vrai agent ni une vraie forge**.

- [ ] Relecture d'un plan : la case « Attendre la fusion de la MR de chaque ticket avant de lancer le suivant » est cochée par défaut. La décocher puis valider : la fenêtre de confirmation dit que chaque ticket part dès que la MR du précédent est ouverte.
- [ ] Plan validé avec la case cochée : le ticket 1 se termine (MR ouverte) et le ticket 2 ne part pas. La page Plans affiche « À noter : En attente de la fusion de la MR !N... » ; la fenêtre de l'Intendant affiche la même phrase en note, pas en rouge.
- [ ] Fusionner cette MR (sur la forge, ou depuis la tâche : publier la review puis le bouton de fusion) : en 45 secondes au plus, le ticket 2 part et l'explication disparaît. Sa branche contient le code du ticket 1.
- [ ] Fermer une MR sans la fusionner : le ticket passe en échec (« fermée sans être fusionnée »), le plan s'arrête ; « Écarter » puis « Reprendre » lance le suivant.
- [ ] Projet dont la branche de base et la branche cible diffèrent : le plan attend avec un message qui nomme les deux branches ; « Ne plus attendre » le libère.
- [ ] Sur un plan en cours, le bouton « Ne plus attendre » (ou « Attendre la fusion ») sous le plan change le réglage tout de suite.

## 11 septies. Visualiseur de code et notifications (2026-11-27)

Les tests automatiques passent (1008), mais **aucun essai avec une vraie forge, un vrai Discord ou Slack, ni dans un navigateur**.

**Code généré**
- [ ] Page d'une tâche qui a ouvert une MR : la section « Code généré » propose « Afficher le code ». Un clic lit le diff chez la forge : liste de fichiers repliables, lignes ajoutées en vert et supprimées en rouge, numéros de ligne, totaux en tête, lien « ouvrir la MR ».
- [ ] Mode sombre : les couleurs restent lisibles. Une ligne très longue défile horizontalement sans casser la page.
- [ ] Une MR avec de nombreux ou de gros fichiers : les premiers sont dépliés, les gros s'ouvrent à la demande, et un message renvoie vers la forge pour ce qui dépasse les limites.
- [ ] Une MR déjà fusionnée : le code s'affiche encore. Un texte comme `<script>` dans le code s'affiche tel quel, sans s'exécuter.
- [ ] Page Plans : « Voir le code » sur un ticket qui a ouvert une MR ; la page se rafraîchit seule mais le ticket reste déplié et le code reste affiché.

**Notifications**
- [ ] Créer un webhook dans un salon Discord (Paramètres du salon > Intégrations > Webhooks > Nouveau webhook > Copier l'URL), le coller dans Paramètres > Connexion > Notifications, Enregistrer : la pastille devient verte « Discord : enregistré, chiffré ».
- [ ] « Envoyer un message de test » : le message arrive dans le salon. Une adresse qui n'est pas un webhook Discord ou Slack est refusée à l'enregistrement.
- [ ] Supprimer le webhook côté Discord puis refaire un test : l'outil affiche « Discord a refusé le message (HTTP 404) ».
- [ ] Plan avec un ticket en échec : un message « Plan en échec » avec la raison. Plan terminé : un message « Plan terminé ».
- [ ] Plan avec l'attente de fusion : un seul message « MR à fusionner » par MR, avec son lien. Après la fusion, le plan repart sans nouveau message.
- [ ] Review qui passe en « à analyser » : un message avec le titre de la MR et les motifs. Un titre de MR contenant `@everyone` ne mentionne personne.
- [ ] Enregistrer l'adresse puis chercher un morceau de l'adresse dans `data/logs` et dans la réponse de `GET /api/notify` : nulle part.

## 12. Pas testé du tout

- Un vrai serveur PostgreSQL (pilote `pg`) : seuls SQLite et PostgreSQL embarqué (PGlite) sont testés. Lancer avec `TEST_DATABASE_URL` pour la suite complète.
- Le dashboard dans plusieurs navigateurs.
