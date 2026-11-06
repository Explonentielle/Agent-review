<!--
  Tes instructions de review perso : elles sont ajoutées à la fin de review-system.md.
  Ce fichier est relu à chaque review, inutile de redémarrer après une modification.
  Écris ce que TU vérifies d'habitude et que le prompt générique ne couvre pas.
-->

## Stack et conventions

Les projets n'ont pas tous la même stack. Identifie-la avant de juger (`composer.json`, présence de `fuel/` ou `artisan`) et juge le code avec les conventions de SA stack et de SA version :

- **FuelPHP 1.8 / 1.9** (sra-bo, kits, documentation) : MVC Fuel (`fuel/app/classes/controller|model`, vues dans `fuel/app/views`), code ancien, PHP parfois en version basse. Ne suggère pas de patterns Laravel (Eloquent, Facades, FormRequest...) ni de syntaxe PHP plus récente que celle du projet.
- **PHP sans framework** (sra-moteur) : code procédural et classes maison, standard défini par `phpcs.xml` du dépôt. Ne propose pas de réécriture vers un framework.
- **Laravel** : mega-tunnel (11), synchro (12), timelog (13), resalink (7, PHP 7.1). Respecte la version : pas de fonctionnalité Laravel ou PHP absente de la version du projet (resalink surtout).
- Front : JS / jQuery selon les projets. Respecte les conventions déjà en place dans chaque dépôt plutôt que des « bonnes pratiques » génériques.

## Points d'attention systématiques

- **Performance** : requêtes BDD dans des boucles (N+1), index manquants sur une nouvelle colonne filtrée, chargements de gros volumes en mémoire, temps d'exécution (moteur de recherche et imports en particulier).
- **Migrations / scripts SQL** : réversibilité quand le projet en a (`down`), impact sur des tables volumineuses, valeur par défaut des colonnes NOT NULL ajoutées sur une table existante.
- **Sécurité** : secrets en dur dans le code ou la config versionnée (fichiers `config*.php` en particulier), SQL construit par concaténation sans échappement, validation des entrées, contrôle d'accès sur les nouvelles routes ou actions (droits utilisateur, accès agence ou fournisseur).
- **Régressions métier** : tarification, acomptes, réservations et synchronisations fournisseurs. Un changement de calcul ou de format d'échange doit être justifié par le ticket.

## Ce que je ne veux PAS voir remonter

- Remarques de formatage déjà couvertes par le linter / CodeSniffer de la CI.
- Demandes de PHPDoc sur du code auto-explicatif.
- Suggestions de modernisation ou de refactoring hors du périmètre du ticket (le code legacy reste legacy).
