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
| Chance | Critique (5 % de base, +1,2 % par point, 50 % au plus, dégâts x 1,6 ; la dague relève la base, le plafond et le multiplicateur, voir plus bas) et or gagné (+1 % par point, +50 % au plus) |

**Points** : un par niveau du forgeron (le niveau vient du serveur : il se gagne en travaillant). Les points répartis ne dépassent jamais le niveau ; « Réinitialiser » les rend, sans frais.

**Équipement** : la cape donne de l'Agilité (commun +1, rare +2, épique +4, légendaire +7 points), le tablier de la Vitalité, le couvre-chef de la Chance. **L'arme est unique** : voir « Armes uniques » plus bas. Sans arme équipée, on se bat avec une épée d'entraînement.

## Les armes

Les sept types de la forge ont chacun leur façon de se battre.

| Arme | Dégâts | Cadence | Portée | Effet qui la distingue |
|---|---|---|---|---|
| Épée | 12 | 0,45 s | moyenne (22) | Équilibrée : la référence, aucun point faible |
| Hache | 18 | 0,8 s | courte (20), très large | **Balayage** : touche tous les ennemis devant toi (170°) |
| Marteau | 28 | 1,15 s | courte (20) | Assomme 0,6 s, plus une **onde de choc** : 40 % des dégâts, sans critique, à tout ennemi près du point d'impact (rayon 30), même hors de l'arc du coup |
| Dague | 6 | 0,26 s (très rapide) | très courte (15) | **Critique** : +20 points de chance de base et dégâts critiques x 2,2 (au lieu de x 1,6) ; le plafond de critique monte d'autant (70 % au lieu de 50 %) |
| Lance | 13 | 0,55 s | moyenne+ (32), pointe étroite | **Transperce** : la poussée touche les 2 premiers ennemis alignés (les plus proches) |
| Arc | 7 | 0,38 s (rapide) | longue (260) | Flèches rapides (300 px/s), faibles dégâts ; tire sur le plus proche, où qu'il soit |
| Bâton | 13 | 0,85 s | longue (200) | Trait lent qui traverse tout et **ralentit** de 40 % pendant 1,5 s ; contre le seigneur : 15 % pendant 0,75 s |

Le profil de l'arme équipée (et son effet) s'affiche en haut de **Profil > Combat**, dans l'introduction de l'arène et dans les explications du Maître d'armes. La rareté multiplie toujours les dégâts, et la Force s'y ajoute.

## Armes uniques et choix de l'arme

Une arme du butin n'est plus un modèle fixe : **chaque exemplaire est unique**. Ses valeurs sont tirées dans des fourchettes qui dépendent de sa rareté (`ROLL_RANGES`, `combat.js`), à partir de son type, de sa rareté et d'une **graine** (l'identifiant de l'événement de butin). Même graine, mêmes valeurs : recharger ne change rien, rien à stocker, et un futur serveur de PvP pourra recalculer l'arme depuis l'événement.

| Rareté | Dégâts (x) | Cadence (x délai) | Force | Lignes de bonus en plus | Points par ligne |
|---|---|---|---|---|---|
| Commun | 0,90 à 1,10 | 1,06 à 0,94 | 1 à 2 | 0 | |
| Rare | 1,00 à 1,30 | 1,04 à 0,92 | 2 à 4 | 0 à 1 | 1 à 3 |
| Épique | 1,20 à 1,50 | 1,00 à 0,88 | 4 à 7 | 1 à 2 | 2 à 5 |
| Légendaire | 1,40 à 1,80 | 0,96 à 0,82 | 7 à 12 | 2 à 3 | 3 à 7 |

Les fourchettes se **chevauchent** : un bon rare peut valoir mieux qu'un mauvais épique, et un jet parfait ou très faible existe à chaque rareté. Les lignes de bonus tombent sur des caractéristiques différentes (Agilité, Vitalité, Chance), jamais deux fois la même. La **qualité du jet** (0 à 100 %, moyenne des tirages) s'affiche : jet faible, moyen, bon, très bon, exceptionnel. Une arme sans graine (ancienne sauvegarde, objet du catalogue, arme d'entraînement) vaut la moyenne de sa rareté, comme avant.

**Où les armes tombent** : une pièce forgée, une review terminée (une fois sur deux), une pièce fusionnée (meilleures chances) et, un peu, **la création d'un projet** (une fois sur trois environ, raretés plus basses, seuls les 20 premiers projets comptent : créer un projet est facile). Un échange de 3 objets contre 1 de la rareté au-dessus donne aussi une arme tirée au sort.

**Comment équiper une arme** :
- **Dans l'arène** : à l'écran d'introduction (avant chaque combat), la rangée de pastilles montre toutes tes armes. **Flèches gauche et droite** (ou Q et D), ou un clic sur une pastille, changent l'arme, et les valeurs du forgeron se recalculent aussitôt. Après un combat : « Changer d'arme (A) ».
- **Chez le Maître d'armes** : « Changer d'arme » ouvre la page **Armes** du profil.
- **Dans le profil** (P), onglet **Armes** : l'arme portée en détail, puis toutes les armes avec leurs dégâts, leur cadence, leurs bonus, la qualité du jet et la différence de dégâts par seconde avec l'arme portée. Le sac (I) permet aussi de les équiper.

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

- **Une arme** (nouveau type dans le butin, `src/game/loot.ts`) : ajouter son profil dans `WEAPONS` de `combat.js`, avec un `perk` (l'effet affiché) différent de celui des autres. Un effet est un champ du profil : `critBonus` et `critMult` (critique), `maxHits` (transperce), `shock` (onde de choc), `slow` (ralentit), `stun`, `pierce`, ou `ranged` avec `range` et `projSpeed`. Le test de cohérence (`src/rooms/combat.test.ts`) échoue tant qu'une arme ou une rareté du butin n'a pas sa place dans l'arène, et un autre exige qu'aucune arme n'annonce le même effet qu'une autre.
- **Un bot** : `BOTS` (statistiques), son apparence dans `BOT_LOOKS` (`arena.js`) et sa vague dans `WAVES`.
- **Une caractéristique** : `STATS`, `SLOT_STAT` et la formule dans `build`, puis l'onglet Combat.

## Limites connues

- **Équilibrage réglé contre un joueur automatique simple** (il approche, frappe, roule quand un coup s'arme). Une vraie personne joue mieux ; les valeurs sont dans `combat.js` et se règlent en quelques lignes, après tes essais. Ce joueur automatique ne sait pas garder ses distances : l'arc et le bâton, qui s'y prêtent, y paraissent plus faibles qu'ils ne le sont (ils ne battent pas le seigneur dans la simulation), à vérifier à la main.
- **Progression dans le navigateur** : points, or, équipement et record ne suivent pas d'un navigateur à l'autre. C'est la règle de toute la forge (voir `docs/architecture.md`).
- **Clavier uniquement** : pas de commandes tactiles.
- **Solo** : le duel entre personnes demande des statistiques validées par le serveur (donc une migration) : roadmap, item 40.
