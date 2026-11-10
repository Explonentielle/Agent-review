# Déploiement sur le VPS (pilote)

Statut au 2026-11-10 : **préparé, jamais construit ni lancé** (aucune image n'a été construite, aucun conteneur démarré : cela demande de télécharger des paquets, ce qui n'a pas été fait). La syntaxe du fichier compose, des scripts et la compilation de production (`tsc -p tsconfig.build.json`, 68 modules chargés sans erreur) sont vérifiées. Le premier `docker compose build` peut révéler des erreurs : note-les, elles se corrigent vite.

Fichiers : `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `tsconfig.build.json`, `scripts/backup.sh`, `scripts/restore.sh`.

## 1. Ce que ça installe

- **app** : l'outil (Node 24, CLI Claude Code, git), utilisateur sans droits, système de fichiers en lecture seule sauf le volume de données et `/tmp`, aucune capacité Linux, 2,5 Go de mémoire et 2 processeurs au plus. Port publié **sur la boucle locale seulement** (`127.0.0.1:4321`).
- **postgres** : PostgreSQL 16, aucun port publié, sur un réseau sans accès à Internet. Seule l'application le joint.
- Deux volumes : `appdata` (copies de dépôts, dossiers de travail des agents, journaux, configuration de la CLI) et `pgdata` (la base).

## 2. Cohabitation avec rag-saas

Le VPS (4 vCores, 8 Go, Ubuntu 26.04) héberge déjà rag-saas en production (Caddy sur 80, 443 et 8443, Elasticsearch ~1,9 Go, un service d'OCR). Il reste environ 5 Go disponibles, sans swap. Les plafonds du fichier compose (2,5 Go pour l'application, 0,5 Go pour la base) laissent environ 2 Go de marge : **ne les augmente pas sans regarder `free -h`**. Un seul agent à la fois (`MAX_CONCURRENT_AGENTS=1`, valeur par défaut). L'outil n'utilise aucun des ports de rag-saas.

## 3. Préparer le serveur (une fois)

1. **Swap de 2 Go**, pour absorber un pic sans que le noyau tue Elasticsearch ou rag-saas :
   ```
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
   `fallocate` réserve le fichier, `chmod 600` le rend illisible aux autres, `mkswap` le formate en swap, `swapon` l'active, et la dernière ligne l'active aussi après un redémarrage.
2. **Un utilisateur Linux dédié** (`review`), sans sudo, qui possède le dossier du projet. Pour lancer Docker il doit être dans le groupe `docker`, ce qui équivaut à un accès root à la machine : ne l'utilise pas pour autre chose.
3. **Ne rien ouvrir dans le pare-feu.** L'accès se fait par tunnel SSH (section 6). Après le démarrage, `ss -tlnp | grep 4321` doit montrer `127.0.0.1:4321` et rien d'autre.

## 4. Configurer

Dans le dossier du projet sur le serveur, crée le fichier `.env` (`chmod 600 .env`), à partir de `.env.example`. **Je n'y touche pas : tu le remplis toi-même.** Variables propres à ce déploiement :

| Variable | Rôle | Comment l'obtenir |
|---|---|---|
| `POSTGRES_PASSWORD` | mot de passe de la base (obligatoire) | `openssl rand -base64 24` |
| `SECRETS_MASTER_KEY` | clé qui chiffre les jetons enregistrés (obligatoire en mode serveur) | `openssl rand -base64 32` |
| `PUBLIC_URL` | adresse que voit ton navigateur | `http://localhost:4321` avec le tunnel |
| `AUTH_*` | connexion par compte de forge (fortement recommandée) | voir `.env.example` et `docs/a-tester.md`, section 5 |
| `GITLAB_URL` et/ou `GITHUB_TOKEN` | forges du propriétaire | comme en local |

`openssl rand -base64 N` tire N octets au hasard et les écrit en base64. **Sauvegarde `SECRETS_MASTER_KEY` à part** (gestionnaire de mots de passe) : sans elle les jetons enregistrés sont perdus, et elle ne doit jamais être dans la même archive que les sauvegardes de la base.

## 5. Lancer

```
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```
`build` construit l'image (plusieurs minutes la première fois), `up -d` démarre la pile en arrière-plan, `ps` doit montrer `app` et `postgres` en bonne santé (`healthy`), `logs -f` suit le journal ; on y lit `app.started`. Les migrations de la base s'appliquent toutes seules au démarrage. Pour figer la version de la CLI Claude Code : `CLAUDE_CODE_VERSION=<version> docker compose build`.

## 6. Y accéder

Depuis ton poste, un tunnel SSH vers le serveur :
```
ssh -N -L 4321:127.0.0.1:4321 review@<adresse-du-vps>
```
`-N` n'ouvre pas de shell, `-L 4321:127.0.0.1:4321` relie le port 4321 de ton poste au port 4321 de la boucle locale du serveur. Laisse la fenêtre ouverte et ouvre http://localhost:4321. Il n'y a pas de TLS : le tunnel SSH chiffre le trajet. Un nom de domaine et un certificat ne sont nécessaires que pour ouvrir à d'autres personnes sans tunnel, et **pas avant** que les conteneurs d'agents (lot D) existent.

## 7. Sauvegardes

- `bash scripts/backup.sh` écrit `backups/review_agent_<date>.sql.gz` (lisible par son propriétaire seul), vérifie qu'elle n'est pas vide, garde les 14 dernières. Exemple de planification quotidienne : `crontab -e` puis `30 3 * * * cd /chemin/du/projet && bash scripts/backup.sh >> backups/backup.log 2>&1`.
- **Copie hors du serveur** : une sauvegarde sur le disque qui tombe en panne ne sert à rien. Récupère le dossier `backups/` régulièrement (`scp`, `rsync`).
- **Restauration** : `bash scripts/restore.sh backups/<fichier>.sql.gz --yes` arrête l'application, supprime la base, la recrée depuis le fichier et redémarre. C'est destructif : **essaie-la une fois avant d'en avoir besoin**, par exemple sur ton poste avec un second projet compose (`docker compose -p essai ...`).
- Le volume `appdata` (copies de dépôts, dossiers de travail) n'est pas sauvegardé : il se reconstitue. On perd seulement la reprise d'une session d'agent en cours.

## 8. Mettre à jour, revenir en arrière

```
bash scripts/backup.sh
git pull
docker compose build
docker compose up -d
```
Sauvegarde d'abord : les migrations de base ne se défont pas. Retour arrière : revenir au commit précédent (`git checkout <commit>`), reconstruire, et si une migration était passée, restaurer la sauvegarde d'avant.

## 9. Limites connues, à lire

- **Les données de ta base locale (SQLite) ne sont pas importées** dans PostgreSQL : il n'existe pas d'outil de transfert. Le serveur repart de zéro ; tu y recrées tes projets et réglages.
- **Tous les agents tournent dans le même conteneur**, avec le même utilisateur système que l'application. Les secrets du `.env` sont retirés de l'environnement des agents (jetons, clé maître, adresse de la base, secrets OAuth) : une commande qui affiche son environnement ne les voit pas. **Ce n'est pas une isolation** : un processus du même utilisateur peut lire l'environnement de son processus parent (`/proc`) et les fichiers du volume de données, dont les copies de dépôts des autres personnes. Tant que les conteneurs par personne (lot D) n'existent pas : **personnes de confiance seulement**.
- Pas de limite de mémoire par agent (seulement celle du conteneur entier) ni d'isolation réseau des agents.
- Les journaux sont dans le volume (`/app/data/logs`), sans rotation. À surveiller si le disque se remplit.
- Rien n'a été essayé sur le vrai VPS : coexistence avec rag-saas, mémoire réelle, durée du build.

## 10. Liste de vérification avant d'inviter quelqu'un

- [ ] `.env` en `chmod 600`, jamais dans git ; `SECRETS_MASTER_KEY` sauvegardée à part.
- [ ] `ss -tlnp | grep 4321` : `127.0.0.1` seulement.
- [ ] La connexion OAuth est active (`AUTH_*` renseigné) : sans session, `curl http://127.0.0.1:4321/api/stats` répond 401.
- [ ] Une sauvegarde existe **et** une restauration a été essayée.
- [ ] `free -h` : au moins 1,5 Go de mémoire disponible une fois la pile démarrée.
- [ ] `AUTH_ALLOWED_USERS` ne contient que des personnes de confiance.
