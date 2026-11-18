# Salles du monde de la forge

Ce document décrit le format des salles livrées avec l'outil (`public/rooms/`) : la salle du trône (`public/rooms/throne.json`, un exemple) et l'arène. Les salles créées par les personnes (générateur par agent, jeux libres, visites) ont été retirées le 2026-11-18 : voir la fin du document.

Une salle est un fichier de **données** : `public/rooms/<id>.json`. Elle ne contient ni code, ni image, ni HTML. Le navigateur la dessine avec les objets d'un catalogue fermé (`src/rooms/catalog.ts`). Le serveur ne livre que les salles qui passent toutes les vérifications (`GET /api/rooms`).

Créer ou modifier une salle :

1. Écrire ou changer `public/rooms/<id>.json` (le nom du fichier est l'identifiant de la salle).
2. Vérifier : `npx tsx scripts/check-rooms.ts`. Chaque problème est dit en français. Un fichier refusé n'empêche pas les autres de se charger.
3. Les tests (`src/rooms/rooms.test.ts`) vérifient aussi toutes les salles livrées.

Exemple complet : `public/rooms/throne.json` (la salle du trône).

## Le fichier

```json
{
  "format": 1,
  "id": "throne",
  "name": "La salle du trône",
  "theme": "castle",
  "hub": true,
  "spawn": [12, 12],
  "objects": [ { "type": "throne", "x": 11, "y": 3, "text": "Un trône inconfortable." } ],
  "npcs": [ { "id": "king", "name": "Le Roi", "look": "king", "x": 11, "y": 5, "dir": "down", "lines": ["Approche, {name}."] } ],
  "doors": [ { "x": 11, "to": "forge", "label": "Retour à la forge" } ]
}
```

| Champ | Règle |
|---|---|
| `format` | toujours `1` |
| `id` | minuscules, chiffres et tirets (1 à 30 caractères), identique au nom du fichier ; `forge` est réservé |
| `name` | nom affiché, 40 caractères au plus |
| `theme` | `forge`, `castle` ou `tavern` : couleurs du sol et des murs |
| `hub` | `true` : une porte magique vers cette salle apparaît dans le mur du fond de la forge (trois salles au plus, par ordre d'identifiant) |
| `spawn` | `[colonne, rangée]` où apparaît la personne qui entre |
| `objects` | 80 au plus, voir le catalogue |
| `npcs` | 8 au plus |
| `doors` | 1 à 4 portes dans le mur du bas |

## La grille

La salle fait **24 colonnes sur 15 rangées**, numérotées à partir de 0.

- Rangées **0 à 2** : le mur du fond (torches, bannières, fenêtres, bibliothèques s'y accrochent).
- Rangées **3 à 13** : le sol, où l'on marche et où l'on pose les meubles et les personnages.
- Rangée **14** : le mur du bas, où se trouvent les portes (deux tuiles de large, `x` de 1 à 21).

## Le catalogue des objets

| Type | Taille | Zone | Plein | Option |
|---|---|---|---|---|
| `carpet` | `w` et `h` au choix | sol | non | `color` |
| `pillar` | 1 x 2 | sol | oui | |
| `statue` | 1 x 2 | sol | oui | `text` |
| `throne` | 2 x 2 | sol | oui | `text` |
| `table` | 3 x 2 | sol | oui | `text` |
| `chair`, `chest`, `barrel`, `crate` | 1 x 1 | sol | oui | `text` pour `chest` |
| `torch` | 1 x 1 | mur | non | |
| `banner` | 1 x 2 | mur | non | `color` |
| `window`, `bookshelf` | 2 x 2 | mur | non | `text` |
| `tapestry` | 2 x 2 | mur | non | `color` |
| `dummy`, `armorstand` | 1 x 2 | sol | oui | |
| `brazier`, `plant` | 1 x 1 | sol | oui | |
| `fountain` | 2 x 2 | sol | oui | |

- `x` et `y` sont la case en haut à gauche de l'objet. La taille est celle du tableau (seul le tapis se règle avec `w` et `h`).
- Couleurs : `red`, `blue`, `green`, `purple`, `gold`.
- Un objet avec `text` se lit en s'en approchant et en appuyant sur E. Un objet de mur à lire doit descendre jusqu'à la rangée 2 (`y` + hauteur = 3) pour qu'on puisse le toucher depuis le sol.
- Les objets pleins ne se chevauchent pas. Un tapis passe sous les meubles.

## Les personnages

`id` (unique dans la salle), `name` (30 caractères), `look` (`brann`, `apprenti`, `apprenti2`, `apprenti3`, `gardien`, `scribe`, `marchand`, `king`, `queen`, `noble`, `armurier`), `x`, `y` (au sol), `dir` (`up`, `down`, `left`, `right`), `lines` (1 à 8 répliques de 220 caractères au plus). `{name}` est remplacé par le nom du joueur.

## Les portes

`x` (colonne de gauche des deux tuiles), `to` (`forge` ou l'identifiant d'une autre salle qui existe), `label`, `style` facultatif (`wood`, par défaut, ou `iron` : la herse de fer de l'arène) et `spawn` facultatif (où l'on arrive dans la salle d'arrivée). Revenir dans la forge ramène sous la porte magique d'où l'on est venu.

## Ce qui est vérifié

- La forme du fichier : aucun champ inconnu (donc aucun script), types, thèmes et apparences du catalogue seulement.
- Les textes : 220 caractères au plus par réplique ou texte, 6000 au total, aucun caractère de contrôle, **aucun chevron `<` ou `>`**. Le jeu affiche tout comme du texte, jamais comme du HTML.
- La grille : chaque objet dans sa zone, pas de chevauchement entre objets pleins ni avec un personnage, arrivée au sol et libre.
- La jouabilité : depuis l'arrivée, on peut atteindre chaque personnage, chaque objet à lire et chaque porte.
- Les portes mènent à la forge ou à une salle qui existe. Fichier de 64 Ko au plus, 50 salles au plus.


## L'arène

`public/rooms/arene.json` est une salle livrée comme les autres, mais sans `hub` : on y entre par la herse de fer du mur du bas de la forge, pas par une porte magique. Son Maître d'armes (`maitre-armes`) lance les combats : voir `docs/arene.md`.

## Ce qui a été retiré (2026-11-18)

Les salles créées par les personnes n'existent plus : champ `game` et `"plays"` d'une salle, moteur de jeu à règles et son robot, générateur par agent, salles d'utilisateurs privées ou d'équipe, Architecte, quête « Dessiner ta première salle », prompts `rooms-*`. Les salles livrées (`public/rooms/`) restent la seule source de salles ; le code retiré reste lisible dans l'historique git (item 41 de la roadmap).
