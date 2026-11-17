# L'arène et les caractéristiques

Une salle de la forge où l'on se bat en temps réel contre des bots, avec l'équipement de son sac. Tout est dans le navigateur : aucune table, aucune route, aucune migration. Première version : solo. Le multijoueur est noté (roadmap, item 40).

## En bref, pour la personne qui joue

1. Quand ta première arme est posée au râtelier, une **herse de fer** apparaît dans le mur du bas de la forge (une autre porte que les portes magiques violettes du mur du fond). Maître Brann t'y envoie.
2. Dans la salle de l'arène, le **Maître d'armes** t'explique tout, puis propose : combattre, régler ses caractéristiques, ou réécouter les règles.
3. **Chaque niveau te donne un point** à répartir entre quatre caractéristiques, dans **Profil > Combat**. Les objets que tu portes en ajoutent selon leur rareté.
4. Le combat : **cinq vagues de bots, puis le Seigneur des braises**. À la fin, un peu d'or et un record.

Commandes : flèches ou ZQSD pour bouger, **Espace** pour frapper (le coup part vers l'ennemi proche, devant toi), **Maj** pour une roulade (intouchable un instant), Échap pour quitter, R pour rejouer.

## Les caractéristiques

| Caractéristique | Effet |
|---|---|
| Force | Dégâts : +6 % par point |
| Agilité | Vitesse de déplacement (+1,2 % par point, 50 points au plus comptés), vitesse d'attaque (+1 % par point, 60 au plus), roulade plus fréquente (jusqu'à 0,7 s) |
| Vitalité | Points de vie : +8 par point (base : 50 + 2 par niveau) |
| Chance | Critique (5 % de base, +1,2 % par point, 50 % au plus, dégâts x 1,6) et or gagné (+1 % par point, +50 % au plus) |

**Points** : un par niveau du forgeron (le niveau vient du serveur : il se gagne en travaillant). Les points répartis ne dépassent jamais le niveau ; « Réinitialiser » les rend, sans frais.

**Équipement** : chaque emplacement nourrit sa caractéristique. L'arme donne de la Force, la cape de l'Agilité, le tablier de la Vitalité, le couvre-chef de la Chance. Commun +1, rare +2, épique +4, légendaire +7 points. La rareté d'une arme multiplie aussi ses dégâts (x 1, 1,15, 1,35, 1,6). Sans arme équipée, on se bat avec une épée d'entraînement.

## Les armes

Les sept types de la forge ont chacun leur façon de se battre.

| Arme | Dégâts | Cadence | Particularité |
|---|---|---|---|
| Épée | 12 | 0,45 s | Équilibrée, portée moyenne |
| Hache | 18 | 0,8 s | Large : touche tout ce qui est devant (170°) |
| Marteau | 28 | 1,15 s | Très lent, assomme 0,6 s |
| Dague | 8 | 0,26 s | Très rapide, très courte |
| Lance | 13 | 0,55 s | Longue portée, étroite |
| Arc | 11 | 0,65 s | Flèche à distance, vise le plus proche |
| Bâton | 13 | 0,85 s | Trait magique lent, traverse les ennemis |

## Les bots et les vagues

| Vague | Bots |
|---|---|
| 1 Les rôdeurs | 2 gobelins (dague) |
| 2 La garde | 2 gobelins, 1 soldat (épée) |
| 3 Tirs croisés | 2 soldats, 1 archer (arc) |
| 4 Les brutes | 1 brute (marteau), 1 mage (bâton), 2 gobelins |
| 5 Le Seigneur des braises | le seigneur (hache légendaire) : une **charge annoncée** (bande rouge au sol), et du renfort quand il passe sous la moitié de sa vie |

Chaque bot **arme son coup** : un « ! » rouge apparaît au-dessus de lui avant de frapper, ce qui laisse le temps de rouler. Les bots deviennent plus solides avec le niveau du forgeron (+4 % de vie et +2,5 % de dégâts par niveau) et avec la vague. On récupère 35 % de sa vie entre deux vagues.

## Récompenses

Par vague terminée : 3 + 2 x numéro de la vague, plus 25 pour la victoire (70 or au total pour les cinq vagues), majoré par la Chance. **Plafond de 150 or par jour.** L'arène donne aussi un record (vagues terminées, victoires).

**Pas d'XP, pas d'objet rare, pas de classement** : la progression est dans le navigateur, donc modifiable à la main. Ces récompenses viendraient de données falsifiables ; l'XP et le butin restent ceux du vrai travail, calculés par le serveur.

## Où est quoi

| Fichier | Rôle |
|---|---|
| `public/forge/combat.js` | Logique pure (aucun DOM) : caractéristiques, armes, bots, vagues, combat à pas fixe et graine (même combat = même déroulé). Chargé par le navigateur et par les tests |
| `public/forge/arena.js` | Calque plein écran : touches, dessin en pixel art, écrans d'intro et de fin. Fermé quand on quitte l'onglet de la forge (il capture le clavier) |
| `public/forge/game.js` | La herse dans la forge, le Maître d'armes, l'onglet Combat du profil, l'or et le record (`g.save.stats`, `g.save.arena`) |
| `public/rooms/arene.json` | La salle de l'arène : une salle livrée comme les autres (donnée), sans porte magique. Le jeu retrouve le Maître d'armes par son identifiant (`ARENA_ROOM`, `ARENA_MASTER` dans `game.js`) |
| `public/forge/sprites.js` | `ironGate` (herse de fer) et l'apparence `armurier` |

La porte de fer est aussi un **style de porte** (`"style": "iron"`) utilisable dans toute salle : voir `docs/salles.md`.

## Ajouter une brique

- **Une arme** (nouveau type dans le butin, `src/game/loot.ts`) : ajouter son profil dans `WEAPONS` de `combat.js`. Le test de cohérence (`src/rooms/combat.test.ts`) échoue tant qu'une arme ou une rareté du butin n'a pas sa place dans l'arène.
- **Un bot** : `BOTS` (statistiques), son apparence dans `BOT_LOOKS` (`arena.js`) et sa vague dans `WAVES`.
- **Une caractéristique** : `STATS`, `SLOT_STAT` et la formule dans `build`, puis l'onglet Combat.

## Limites connues

- **Équilibrage réglé contre un joueur automatique simple** (il approche, frappe, roule quand un coup s'arme). Une vraie personne joue mieux ; les valeurs sont dans `combat.js` et se règlent en quelques lignes, après tes essais.
- **Progression dans le navigateur** : points, or, équipement et record ne suivent pas d'un navigateur à l'autre. C'est la règle de toute la forge (voir `docs/architecture.md`).
- **Clavier uniquement** : pas de commandes tactiles.
- **Solo** : le duel entre personnes demande des statistiques validées par le serveur (donc une migration) : roadmap, item 40.
