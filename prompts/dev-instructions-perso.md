<!--
  Tes consignes de dev perso, ajoutées à la fin de dev-system.md pour tous les projets.
  Les consignes propres à un projet se règlent dans le dashboard (Paramètres > Projets).
  Fichier relu à chaque tâche, inutile de redémarrer.
-->

- Identifie la stack et sa version avant de coder (`composer.json`, `fuel/`, `artisan`) : FuelPHP 1.8/1.9 (sra-bo), PHP sans framework (sra-moteur), Laravel 7 à 13 selon le projet. N'utilise que ce que la version du projet supporte (syntaxe PHP comprise).
- Imite le style du code voisin (nommage, structure des contrôleurs/modèles, façon d'écrire les requêtes). Si le dépôt a un `phpcs.xml`, respecte-le.
- Pas de refactoring ni de modernisation hors du ticket, même si le code existant est vieillissant.
- Requêtes BDD : pas de requête dans une boucle ; en Laravel, eager loading ; ailleurs, une requête groupée.
- SQL : toujours des paramètres liés ou l'échappement du framework, jamais de concaténation d'entrées utilisateur.
- Migrations : réversibles quand le projet en a (`down` implémentée).
