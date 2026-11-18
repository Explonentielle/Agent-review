# Jeux dans les salles : le moteur à règles

Une salle de la forge peut contenir un **jeu**. Un jeu n'est **pas du code** : c'est une description (une carte, des objets, une physique, des règles, une condition de victoire) que le moteur de la forge exécute. Aucun code venu d'un utilisateur ne s'exécute jamais, ni chez lui, ni chez ceux qui visitent sa salle.

Le moteur est un seul fichier, `public/forge/engine.js` : le navigateur le joue, le serveur s'en sert pour contrôler un jeu avant de le garder (`src/rooms/engine.ts` le charge dans un contexte isolé). Ce que le serveur contrôle est donc exactement ce que le joueur jouera.

## En bref, pour la personne qui crée

1. Tu parles à **l'Architecte** (en bas à gauche de la forge) et tu décris ta salle, avec un jeu si tu veux : « un platformer avec des pièces, des slimes et un drapeau tout en haut ».
2. L'Architecte (un agent sans aucun outil) écrit **une description**, pas du code. Le code de l'outil la contrôle, puis **un robot essaie de gagner le niveau** avec les vraies règles. Si le niveau est impossible, l'Architecte est renvoyé le corriger.
3. Tu **visites** la salle, tu **joues**, puis tu la **gardes**. Elle est **privée** tant que tu ne la partages pas à ton équipe.

## Le format

Un jeu est le champ `game` d'une salle ; un personnage de la salle a `"plays": true` : c'est lui qui propose « Jouer ? ». Voir `prompts/rooms-example.json` pour un exemple complet (La montée au drapeau) : c'est l'exemple donné au générateur de salles, pas une salle livrée.

| Champ | Rôle |
|---|---|
| `title`, `intro` | Nom du jeu (40 caractères) et phrase d'explication (220) |
| `mode` | `platformer` (vue de côté, gravité, saut) ou `topdown` (vue de dessus, pas de gravité) |
| `map` | 15 chaînes de 24 caractères : `.` vide, `#` bloc, `=` plateforme (traversable par en dessous), `^` piques |
| `player` | `x`, `y` (case de départ) et `lives` (vies, 3 par défaut, 9 au plus) |
| `physics` | Facultatif : `gravity` (0 à 1500), `speed` (30 à 200), `jump` (100 à 400) |
| `things` | Les objets posés (60 au plus) |
| `rules` | Les règles (30 au plus) |
| `win` / `lose` | Les conditions de victoire et de défaite |

### Les objets (`things`)

Chaque objet : `kind`, `x`, `y`, et facultativement `id`, `value` (points d'une pièce ou d'une gemme) et `move` (`pattern`, `range` en tuiles, `speed` en px/s, pour un ennemi).

| `kind` | Effet de base |
|---|---|
| `coin` | +1 point, disparaît |
| `gem` | +5 points |
| `key` | une clé (ouvre une `door`) |
| `heart` | +1 vie (9 au plus) |
| `goal` | un drapeau à atteindre |
| `door` | un mur, qu'une clé ouvre en la touchant |
| `spring` | propulse le joueur (plateforme) |
| `slime` | ennemi qui marche et patrouille |
| `bat` | ennemi qui vole |
| `skull` | ennemi qui poursuit le joueur |

`move.pattern` : `none`, `patrol-x`, `patrol-y`, `chase`. Une pièce se pose sur une case vide, jamais dans un bloc ni sur des piques ; un ennemi qui marche se pose sur un bloc.

### Les règles (`rules`)

Une règle : `{ "on": déclencheur, "do": [effets] }`, avec une condition `if` facultative.

- **Déclencheurs** : `start` ; `touch` (avec `kind` ou `id`, et `from` : `above`, `below` ou `side`) ; `defeat` (`kind` ou `id`) ; `timer` (`every` pour répéter, ou `at`, en secondes) ; `score` (`at`) ; `collected_all` (`kind`).
- **Effets** (6 par règle au plus, un effet = un objet à UNE clé) : `score`, `lives`, `keys`, `say` (message), `remove` (`other`, un `id` ou un `kind`), `spawn` (un objet), `teleport`, `bounce`, `flag`, `win`, `lose`, `gravity`, `speed`, `jump`.
- **Conditions** (`if`) : `score_gte`, `lives_gte`, `keys_gte`, `flag`, `not_flag`.

Les effets de base des objets s'appliquent toujours ; les règles **s'ajoutent** (un message, un bonus, un ennemi qui apparaît, une porte qui s'ouvre...).

### Victoire et défaite

`win` est une liste : la première condition vraie gagne. Conditions : `{ "score": n }`, `{ "reach": "goal" }` (ou un `id`), `{ "collect_all": "coin" }`, `{ "defeat_all": "slime" }`, `{ "survive": secondes }`. Une règle qui a l'effet `win` suffit aussi. On perd quand les vies tombent à zéro, ou avec `lose: [{ "time": secondes }]`.

## La physique (plateforme)

Pixels et secondes, une tuile = 16 px. Par défaut : gravité 900, vitesse 80, saut 270. Un saut monte d'environ **2,5 tuiles** et franchit environ **3 tuiles**. Pour qu'un niveau soit faisable : deux plateformes successives ne sont pas plus de 2 tuiles plus haut l'une que l'autre et laissent un trou de 2 tuiles au plus. Écraser un ennemi par le dessus le tue ; le toucher de côté coûte une vie (puis 1,2 s de protection). Les piques et le vide coûtent une vie et ramènent au départ. En vue de dessus, la touche d'action donne un coup court devant soi.

Commandes : flèches ou ZQSD pour bouger, espace ou haut pour sauter (plateforme), espace pour frapper (vue de dessus), Échap pour quitter. Le meilleur score de chaque salle est gardé dans le navigateur.

## Ce que le serveur contrôle (`src/rooms/game.ts`)

- **La forme** : aucun champ inconnu, types, nombres dans leurs limites, textes sans chevrons ni caractère de contrôle.
- **Le niveau** : le joueur ne naît pas dans un bloc ni sur des piques (et en plateforme, il est posé sur un bloc), aucun objet dans un bloc, un ennemi qui marche est posé, identifiants uniques, références des règles valides, portes avec une clé.
- **La victoire sur le papier** : au moins une condition, un but qui existe et n'est pas muré, un score atteignable.
- **Le jeu ne plante pas** : le moteur le fait jouer sans écran avec plusieurs suites de touches (positions finies, le joueur ne sort pas de la carte).
- **Le robot** (`solve` dans le moteur, appelé par le générateur) : une recherche automatique d'une victoire. Trouver un chemin **prouve** que le niveau est gagnable ; ne rien trouver dans le budget (5000 positions, 2,5 s) **ne prouve pas** le contraire. Un niveau valide mais pas prouvé gagnable est montré avec un avertissement : la personne le joue avant de le garder.

## Limites connues

- La jouabilité fine d'un saut n'est pas garantie par le contrôle de forme : c'est le robot, puis la personne, qui la vérifient.
- Un seul jeu par salle, un seul écran (24 x 15 tuiles), pas de défilement.
- Pas de récompense rare venue d'une salle : la progression est dans le navigateur, donc falsifiable. Le jeu ne donne qu'un meilleur score personnel.
- Le robot s'exécute sur le serveur, sans le bloquer plus de 2,5 s par essai.

## Ajouter une brique au moteur

1. `public/forge/engine.js` : le comportement (`KINDS`, `EFFECTS`, `EVENTS`, `WIN_CONDITIONS` et la logique), avec ses tests dans `src/rooms/engine.test.ts`.
2. `src/rooms/game.ts` : le schéma et les règles de contrôle (les listes viennent du moteur).
3. `public/forge/gameplay.js` : le dessin (`DRAW`) d'un nouvel objet.
4. Ce document. Le catalogue donné à l'agent (`roomCatalogPrompt`, `src/rooms/draft.ts`) est généré depuis le moteur : rien à recopier. Le texte d'explication des agents est `prompts/rooms-system.md`.
