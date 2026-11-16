/**
 * Salle modèle : le point de départ proposé par l'Architecte (bouton « Copier le modèle » dans la forge). C'est une salle complète et jouable,
 * à enregistrer sous `public/rooms/ma-salle.json` puis à adapter. Un test vérifie qu'elle passe toujours toutes les vérifications, y compris
 * quand le catalogue évolue : un modèle invalide donnerait un faux départ à celui qui crée sa salle.
 */
export const ROOM_TEMPLATE = {
  format: 1,
  id: "ma-salle",
  name: "Ma salle",
  theme: "tavern",
  hub: true,
  spawn: [12, 12],
  objects: [
    { type: "carpet", x: 8, y: 6, w: 8, h: 5, color: "red" },
    { type: "table", x: 4, y: 6, text: "Une table collante, couverte de chopes." },
    { type: "table", x: 17, y: 6 },
    { type: "chair", x: 4, y: 8 },
    { type: "barrel", x: 2, y: 4 },
    { type: "barrel", x: 21, y: 4 },
    { type: "bookshelf", x: 10, y: 1, text: "Des carnets de commandes et de vieilles recettes." },
    { type: "torch", x: 3, y: 2 },
    { type: "torch", x: 20, y: 2 },
  ],
  npcs: [{ id: "hote", name: "L'hôte", look: "marchand", x: 12, y: 5, dir: "down", lines: ["Bienvenue, {name} ! Installe-toi.", "C'est toi qui décides de ce qu'il y a ici."] }],
  doors: [{ x: 11, to: "forge", label: "Retour à la forge" }],
} as const;
