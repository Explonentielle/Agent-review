# Parcours utilisateur cible de la plateforme

Statut : **spec, rien d'implémenté**. Complète `docs/vision-plateforme.md` (architecture, concurrence, décisions). Ce document décrit ce que vit un utilisateur, de sa première connexion à l'usage quotidien, et liste les écosystèmes à brancher.

## 1. Qui utilise la plateforme

| Rôle | Ce qu'il fait |
|---|---|
| **Développeur** | Traite ses tickets avec l'agent, relit ses MR, fait des reviews, reprend une MR avec des consignes. Rôle principal. |
| **Responsable d'équipe (admin)** | Définit les modèles d'environnement partagés, les règles, les quotas et les intégrations communes. Voit l'audit et la consommation. |
| **Support** | Reçoit les tickets clients, valide les réponses rédigées et les tickets de dev générés. |
| **Relecteur invité** | Accès en lecture aux tâches et aux reviews, sans pouvoir lancer d'agent. |

## 2. Principes de conception

1. **Une checklist de démarrage persistante** : chaque étape est utilisable seule, peut être sautée et reprise plus tard. L'utilisateur voit toujours ce qu'il lui reste à brancher.
2. **L'agent propose, l'humain valide** : image d'environnement, configuration d'un projet, consignes, réponse client, ticket de dev. Jamais d'effet externe sans validation tant que l'utilisateur n'a pas activé l'automatisation.
3. **Mode ombre par défaut partout** : un nouveau connecteur lit, analyse et prépare, mais n'écrit rien chez un tiers (commentaire, approbation, note client, ticket) avant activation explicite.
4. **Secrets cloisonnés** : les jetons de forge et de trackers restent dans le plan de contrôle. Seule la session ou la clé Claude de l'utilisateur entre dans son conteneur.
5. **Tout est réglable dans le dashboard**, avec des valeurs par défaut génériques et des modèles de configuration partageables dans une équipe.
6. **Tout ce qui est écrit sur un système externe est tracé** (qui, quand, quoi, sur quelle demande).

## 3. Le parcours, étape par étape

### Étape 0 : première connexion et création de l'espace
- **L'utilisateur** : se connecte avec son compte GitLab, GitHub ou le SSO de l'entreprise (OAuth ou OIDC). Aucun mot de passe propre à la plateforme.
- **La plateforme** : crée son profil et un **espace** (personnel, ou celui de son équipe s'il y est invité). Affiche la checklist de démarrage (étapes 1 à 6).
- **Garde-fous** : les droits demandés à la forge sont minimaux et détaillés avant le consentement. Le jeton OAuth est stocké chiffré côté plan de contrôle.

### Étape 1 : créer son environnement (le conteneur)
Un environnement correspond à une **stack**. Un utilisateur peut en avoir plusieurs (ex. PHP 7.3 pour un projet ancien, PHP 8.4 pour un autre), et un environnement accueille plusieurs projets.

1. **Choix de départ** : partir d'un **modèle d'équipe** (ex. « PHP 7.3 + MySQL 5.7 »), **décrire la stack en quelques lignes**, ou **détecter depuis un dépôt** (l'agent lit `composer.json`, `package.json`, `.tool-versions`, Dockerfile existant...).
2. **Formulaire guidé** : langages et versions, extensions système, gestionnaire de dépendances, services annexes (base de données de test, cache), variables non secrètes, commande d'installation des dépendances, commandes de test et de lint.
3. **Génération par l'agent** : il produit un `devcontainer.json` et un Dockerfile à partir du formulaire. Cet agent a des droits réduits : il écrit des fichiers de description, il ne lance rien et n'a pas accès au réseau.
4. **Vérification automatique** (pipeline fixe, hors modèle) :
   - construction dans un bac à sable isolé ;
   - les versions installées correspondent à la demande ;
   - l'image de base appartient à une liste autorisée, les paquets sont figés ;
   - scan de vulnérabilités et recherche de secrets dans l'image ;
   - test à blanc : installation des dépendances et exécution des tests sur un dépôt d'exemple, ou sur le premier dépôt ajouté ;
   - taille et durée de construction mesurées.
5. **Validation humaine** : l'utilisateur voit le Dockerfile, le résultat de chaque contrôle et les anomalies. Il valide ou demande une correction à l'agent (nouvelle itération).
6. **Construction définitive** : l'image est versionnée et identifiée par son empreinte. Un **terminal web** s'ouvre dans le conteneur.
- **Sortie** : un environnement prêt, versionné, avec un historique de ses révisions et un retour arrière possible.
- **Échecs prévus** : paquet introuvable, version non supportée, test à blanc en échec. Le message dit quoi corriger, et l'agent propose le correctif.

### Étape 2 : connecter Claude
- **Option A, abonnement** : l'utilisateur lance `claude` dans le terminal web de son conteneur, puis `/login`, et suit le lien de connexion dans son propre navigateur. La session reste dans son conteneur.
- **Option B, clé API** : il saisit sa clé (ou celle de l'équipe, si l'admin l'a prévue). Elle est chiffrée et injectée dans son seul conteneur.
- **Contrôle** : un test d'une requête minimale confirme que ça fonctionne. La plateforme affiche le mode actif (abonnement ou API), sans jamais montrer le secret.
- **Garde-fous** : le plafond de modèle et d'effort réglé par l'admin s'applique dans les deux modes ; un budget mensuel peut être fixé en mode API.

### Étape 3 : ajouter ses dépôts
- **L'utilisateur** : colle les URL de ses dépôts (GitLab, GitHub, autre) et choisit l'environnement qui les accueille.
- **La plateforme** : vérifie l'accès avec le jeton de l'utilisateur, récupère le dépôt dans un miroir du plan de contrôle, et dépose dans le conteneur une **copie de travail autonome**, sans remote ni identifiants. **Le jeton de forge n'entre jamais dans le conteneur**, qui n'a pas non plus d'accès réseau à la forge : seul un patch en sort, appliqué et poussé par le plan de contrôle après contrôles (`vision-plateforme.md`, section 3.4).
- **Analyse par l'agent** (lecture seule) : détecte la stack réelle, les commandes d'installation et de test, la branche par défaut, la structure, les conventions visibles (style, docblocs, tests). Il **propose** :
  - la configuration du projet : branche de départ, branche cible des MR, commandes autorisées ;
  - un brouillon de **consignes propres au projet**, que l'utilisateur relit et corrige ;
  - une alerte si le dépôt est incompatible avec l'environnement choisi (ex. fichiers en ISO-8859-1).
- **Test à blanc** : installation des dépendances et lancement des tests dans le conteneur, avec le résultat affiché.
- **Garde-fous** : les branches protégées de la forge sont lues et interdites à l'agent ; la branche cible ne peut jamais être poussée directement.

### Étape 4 : brancher ses sources de tickets et de support
Pour chaque connecteur (GitLab, GitHub, Jira, Planio / Redmine, tickets internes) :
1. **Authentification** : OAuth quand c'est possible, sinon jeton à portée minimale.
2. **Périmètre** : quels projets, quels filtres (« assignés à moi », une file de support, un tracker).
3. **Rôle du connecteur** : source de **tickets de développement**, source de **demandes de support**, ou les deux.
4. **Correspondance des statuts et labels** : quels labels ou statuts veulent dire « à traiter », « en cours », « validation technique », « à répondre », « résolu ». La plateforme propose, d'après les valeurs observées sur les tickets récents, l'utilisateur confirme.
5. **Liaison avec les dépôts** : à quel dépôt correspond tel projet de tickets.
6. **Mode d'action** du connecteur : lecture seule, brouillons (ombre), ou écriture activée par type d'action.
- **Sortie** : le tableau de tickets se remplit, rangé par colonnes selon la correspondance de statuts.

### Étape 5 : régler la plateforme (Paramètres)
Par niveau de portée : **équipe** (défauts imposés ou recommandés par l'admin), **utilisateur**, **projet** (les plus spécifiques priment, sauf les garde-fous).

| Section | Réglages |
|---|---|
| **Agents** | Modèle, effort, tours maximum, délai, par type de tâche (dev, review, support). Plafonds fixés par l'admin. |
| **Prompts** | Prompt de base remplaçable, consignes de l'utilisateur, consignes du projet. Les garde-fous restent verrouillés. |
| **Conventions** | Nom de branche, message de commit, titre et description de MR, par forge. |
| **Règles de décision** | Seuils, chemins sensibles, ce qui impose une validation humaine. |
| **Automatisation** | Par action : ombre, brouillon, automatique (commenter, approuver, répondre à un client, créer un ticket). |
| **Environnements** | Révisions d'images, mises à jour de sécurité, arrêt automatique après inactivité. |
| **Quotas et coûts** | Budget par utilisateur et par équipe, alertes, consommation affichée. |
| **Équipe** | Membres, rôles, modèles partagés, journal d'audit. |

### Étape 6 : premier essai guidé
La checklist propose trois essais sans risque, dans l'ordre :
1. **Review à blanc** d'une MR déjà fusionnée : l'utilisateur compare avec ce qui avait été dit à l'époque.
2. **Premier ticket**, choisi parmi des tickets simples : l'agent travaille en mode brouillon, l'utilisateur relit le diff avant toute MR.
3. **Demande de support simulée** (si un connecteur de support est branché) : diagnostic et réponse rédigée, rien n'est envoyé.

À chaque essai, un encart demande « décision juste ? », ce qui alimente le **taux d'accord** et sert à décider quand relever le niveau d'automatisation.

### Étape 7 : usage quotidien
- **Tableau de tickets** : colonnes à traiter, en cours, validation technique, support. Bouton « Traiter avec l'agent » ou « Reprendre la MR ».
- **Suivi d'une tâche** : journal en direct, arrêt possible, rapport structuré (résumé, tests, points à vérifier), terminal web pour reprendre la main (`claude --resume`).
- **MR** : toujours en Draft, assignée à l'utilisateur, avec le rapport de l'agent. Reprise avec consignes, nouveau commit par-dessus, jamais de `--force`.
- **Reviews** : MR où l'utilisateur est relecteur, analysées à l'arrivée, avec la liste de ce qui demande son attention.
- **Notifications** : email, Slack, Teams, Discord, pour « MR prête », « agent bloqué », « review à analyser », « demande de support urgente ».

### Étape 8 : évolution et gouvernance
- **Environnements** : nouvelle révision d'image (ajout d'une extension, mise à jour PHP), avec test à blanc et retour arrière.
- **Qualité** : taux d'accord par type de tâche, motifs des désaccords, suggestions d'amélioration des consignes.
- **Coûts** : consommation par utilisateur, par projet et par type de tâche.
- **Audit** : qui a lancé quoi, quelles écritures ont eu lieu sur quelles forges.
- **Fin de vie** : export des données, suppression d'un environnement ou d'un compte, révocation de tous les jetons.

## 4. Parcours transverses

### 4.1 Du support client au correctif
1. **Ingestion et caviardage** : une demande arrive dans Planio, Jira Service Management, par email ou autre (interrogation régulière ou webhook). Avant toute analyse, le plan de contrôle **remplace les données personnelles par des repères stables** (`[EMAIL_1]`, `[NOM_1]`, `[TEL_1]`...). L'agent ne voit que le texte caviardé, les valeurs réelles ne quittent jamais le plan de contrôle. En cas de doute du détecteur, la demande est marquée « à relire » et rien n'est envoyé au modèle (`vision-plateforme.md`, section 3.5).
2. **Tri** : catégorie (bug, question, demande d'évolution), urgence, client concerné, doublons éventuels.
3. **Diagnostic** : l'agent, en **lecture seule**, cherche dans les dépôts concernés et les journaux fournis, et conclut : cause probable, certitude, fichiers impliqués.
4. **Réponse proposée** : brouillon pour le client (ton adapté, sans promesse non validée), enregistré comme **note privée** tant qu'il n'est pas validé. Le brouillon contient des repères : le plan de contrôle les remplace par les vraies valeurs à l'affichage pour le support, et à l'envoi après validation.
5. **Validation humaine** : le support relit, corrige, envoie.
6. **Ticket de développement** : si un correctif est nécessaire, un brouillon de ticket est préparé (contexte, reproduction, impact) et lié à la demande. Il est publié sur la forge **après validation**.
7. **Délégation à l'agent** : l'utilisateur clique sur « Traiter avec l'agent » depuis ce ticket. La MR est créée et liée au ticket de dev, qui est lié à la demande client.
8. **Retour au client** : une fois la MR fusionnée et déployée, un brouillon de message de clôture est proposé, toujours validé par un humain.

### 4.2 Ticket interne (sans forge ou sans tracker)
- Création dans le dashboard : titre, description, dépôt, priorité.
- La MR est publiée sur la forge du dépôt, ou sur un **Gitea embarqué** si le projet n'a pas de forge, et liée au ticket interne.
- Même cycle ensuite : agent, MR Draft, reprise, review, passage en Ready.

### 4.3 Review automatique
- Déclenchement à la réception d'une MR où l'utilisateur est relecteur.
- Résultat classé : **à analyser** (points bloquants, importants, CI en échec, zones sensibles) ou **mineur** (commentaire automatique ou brouillon selon le niveau d'automatisation).
- Approbation automatique réservée au niveau le plus élevé, jamais sans que le commit relu soit celui qui est approuvé.

## 5. Écosystèmes à brancher

| Catégorie | Exemples | Rôle dans la plateforme | Étape du plan |
|---|---|---|---|
| **Forges (code)** | GitLab (auto-hébergé ou .com), GitHub, Bitbucket, Gitea | Dépôts, branches, MR et PR, commentaires, approbations, CI | GitLab : existe. GitHub : étape 2. Gitea : étape 5. Bitbucket : plus tard |
| **Trackers de développement** | Tickets GitLab, tickets GitHub, Jira, Linear, tickets internes | Source des tâches de développement, statuts, labels | GitLab : existe. GitHub : étape 2. Jira : après. Interne : étape 5 |
| **Support et helpdesk** | Planio / Redmine, Jira Service Management, Zendesk, Freshdesk, boîte email (IMAP) | Source des demandes clients, notes privées, réponses | Client Planio écrit, non branché. Reste : après l'étape 3 |
| **Authentification** | OAuth GitLab et GitHub, OIDC / SAML (SSO d'entreprise) | Connexion des utilisateurs, jetons de forge | Étape 3 |
| **Moteurs d'agent** | CLI Claude Code (abonnement), API Claude via le SDK (clé), autres modèles à terme | Exécution des tâches | CLI : existe. API : étape 1 |
| **Environnements** | Docker, devcontainer.json, Coder, Kubernetes | Conteneurs par utilisateur, images, volumes | Étape 4 (Docker), étape 6 (le reste) |
| **CI/CD** | GitLab CI, GitHub Actions, Jenkins | Statuts de pipeline lus par la review, déclenchement de tests | Lecture des statuts : existe pour GitLab |
| **Qualité et sécurité** | Linters du projet, SonarQube, scanners de dépendances et d'images (Trivy) | Contrôles avant push, vérification des images | Images : étape 4. Le reste : après |
| **Communication** | Email, Slack, Microsoft Teams, Discord | Notifications, validations rapides | Après l'étape 3 |
| **Connaissance** | Wiki de forge, Confluence, Notion, dépôt de documentation | Contexte supplémentaire pour l'agent (lecture seule) | Plus tard |
| **Observabilité** | Sentry, journaux applicatifs | Contexte de diagnostic pour le support | Plus tard |
| **Stockage et secrets** | Coffre de secrets (Vault, secrets Docker), base de la plateforme, stockage objet | Secrets chiffrés, sauvegardes, volumes | Étape 3 et 6 |

Chaque connecteur implémente la même interface (lister, lire, commenter, créer, changer de statut) et déclare ce qu'il sait faire : l'interface n'affiche que les actions disponibles.

## 6. Écrans de la version cible

1. **Démarrage** : checklist de l'étape 0 à 6, avec l'avancement.
2. **Tickets** : tableau multi-sources, filtres par source et par projet.
3. **Agent** : tâches en cours et terminées, journal en direct, rapport, reprise.
4. **Reviews** : liste et détail, décisions, taux d'accord.
5. **Support** : file des demandes, diagnostic, brouillon de réponse, ticket de dev lié.
6. **Environnements** : liste, révisions, terminal web, état et consommation.
7. **Projets** : dépôts, configuration, consignes, test à blanc.
8. **Connecteurs** : état, périmètre, correspondance de statuts, mode d'action.
9. **Paramètres** : agents, prompts, conventions, automatisation, quotas.
10. **Équipe et audit** : membres, rôles, modèles partagés, journal d'actions, coûts.

## 7. Ce qui existe aujourd'hui et ce qui reste à construire

| Besoin du parcours | Aujourd'hui (outil local) | À construire |
|---|---|---|
| Connexion et comptes | Aucune (mono-utilisateur local) | OAuth / SSO, espaces, rôles |
| Environnement par utilisateur | Aucun : l'agent travaille dans un dossier de la machine | Orchestrateur, génération et vérification d'images, terminal web |
| Connexion à Claude | CLI de la machine, abonnement | `/login` dans le conteneur, clé API chiffrée, plafonds et budgets |
| Dépôts | Miroir et worktrees locaux, projets configurés à la main | Ajout par URL, analyse par l'agent, test à blanc |
| GitLab | Tickets, MR, reviews, labels : existe | Sur interface de connecteur commune, OAuth |
| GitHub, Jira, Planio, interne | Client Planio écrit, non branché | Connecteurs complets |
| Paramètres | Modèles, règles, workflow, conventions, consignes, prompts de base : existe | Portées équipe, utilisateur, projet ; quotas ; automatisation par action |
| Agent dev et reprise de MR | Existe | Exécution dans le conteneur, tests dans l'environnement du projet |
| Review automatique | Existe, mode ombre | Taux d'accord par type de tâche, niveaux d'automatisation |
| Support client | Non | Ingestion, tri, diagnostic, réponse, ticket de dev lié |
| Notifications | Non | Email, Slack, Teams |
| Audit et coûts | Coût estimé par tâche | Journal d'audit, consommation par utilisateur et par projet |

## 8. Questions ouvertes propres au parcours

1. **Clonage : tranché (2026-11-09).** Le plan de contrôle clone et pousse, le conteneur travaille sur une copie autonome sans identifiants ni accès à la forge, et seul un patch en sort (`vision-plateforme.md`, section 3.4). Reste à préciser, avant l'étape 4 : le mécanisme des jetons de paquets privés à la construction de l'image.
2. **Granularité des environnements** : un conteneur par utilisateur et par stack, ou par projet ? Compromis entre isolation, disque et temps de démarrage.
3. **Agent générateur d'images** : quelles listes blanches d'images de base et de dépôts de paquets ? Qui les maintient ?
4. **Validation humaine du support : proposition retenue.** Obligatoire par défaut. Assouplissement par catégorie seulement après un taux d'accord mesuré, jamais pour les catégories sensibles (réclamations, remboursements, données personnelles, juridique). Seuils chiffrés à confirmer (section 3.5 du document de vision).
5. **Données de support : principe tranché (2026-11-09).** Caviardage avant tout prompt, repères stables, table de correspondance dans le plan de contrôle seul (section 3.5). Reste à valider : durées de conservation exactes avec le DPO, AIPD, conditions du fournisseur selon le mode.
6. **Tickets internes** : besoin réel à court terme, ou à retarder tant que GitLab et GitHub ne sont pas pleinement branchés ?
7. **Équipe** : les réglages d'équipe sont-ils des défauts que chacun peut surcharger, ou des règles imposées ?
8. **Facturation** : si la plateforme sert plusieurs équipes, qui paye les clés API et les conteneurs, et comment la consommation est-elle refacturée ?
