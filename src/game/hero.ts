/**
 * La forge : une couche de jeu de rôle sur l'activité réelle de l'outil. Tout est déduit de ce qui existe déjà (forges connectées, projets,
 * reviews, tâches de l'agent dev) : aucune table, aucune donnée à migrer, et le même historique donne toujours le même héros.
 */

/** Ce que le calcul lit de l'outil. */
export interface HeroInput {
  /** Genres des forges connectées ("github", "gitlab"). */
  forges: string[];
  /** La CLI Claude est connectée. */
  claudeConnected: boolean;
  /** Projets configurés. */
  projects: number;
  /** Projets où l'agent dev est activé. */
  devProjects: number;
  /** Nombre de reviews par statut. */
  reviews: Record<string, number>;
  /** Nombre de tâches de l'agent dev par statut. */
  tasks: Record<string, number>;
  /** XP des paliers de maîtrise franchis (`progress.ts`). */
  bonusXp?: number;
}

export interface Quest {
  id: string;
  title: string;
  hint: string;
  done: boolean;
  xp: number;
  /** Où mener la quête : dans le dashboard. */
  action: "settings" | "terminal" | "tickets" | "reviews";
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
}

export interface Hero {
  heroClass: string;
  specialty: string;
  title: string;
  level: number;
  xp: number;
  /** XP gagnée dans le niveau courant, et taille du niveau. */
  levelXp: number;
  levelSize: number;
  percent: number;
  stats: { label: string; value: number }[];
  quests: Quest[];
  /** Comment gagner de l'XP, générées depuis les mêmes constantes que le calcul. */
  rules: string[];
  /** Première quête à faire, ou null quand elles sont toutes accomplies. */
  nextQuest: string | null;
  achievements: Achievement[];
}

export const REVIEW_DONE = ["needs_human", "auto_ok", "published", "approved"];
const REVIEW_PUBLISHED = ["published", "approved"];
export const TASK_FORGED = ["mr_created", "mr_updated"];
const MAX_LEVEL = 99;

/** XP pour de petites actions plafonnées, afin qu'on ne monte pas de niveau en ajoutant des projets à la chaîne. */
const XP = { forge: 50, forgeCap: 2, claude: 100, project: 20, projectCap: 5, devProject: 30, devProjectCap: 3, review: 10, reviewPublished: 5, forged: 40, blocked: 5, blockedCap: 10 };

const TITLES: [number, string][] = [
  [1, "Apprenti forgeron"],
  [3, "Compagnon forgeron"],
  [5, "Forgeron"],
  [8, "Maître forgeron"],
  [12, "Grand maître de la forge"],
  [20, "Légende de l'enclume"],
];

const sum = (counts: Record<string, number>, statuses: string[]): number => statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
const total = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

/**
 * XP minimale pour atteindre un niveau.
 * @param level Niveau visé (1 et plus).
 * @returns L'XP totale requise : 0, 50, 150, 300, 500...
 */
export function xpForLevel(level: number): number {
  return 25 * level * (level - 1);
}

/**
 * Niveau atteint avec une XP donnée.
 * @param xp XP totale.
 * @returns Le niveau, de 1 à 99.
 */
export function levelFor(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

/**
 * Calcule le héros, ses quêtes et ses hauts faits à partir de l'état réel de l'outil.
 * @param input Forges, connexion Claude, projets, reviews et tâches.
 * @returns Le héros.
 */
export function computeHero(input: HeroInput): Hero {
  const reviewsDone = sum(input.reviews, REVIEW_DONE);
  const reviewsPublished = sum(input.reviews, REVIEW_PUBLISHED);
  const forged = sum(input.tasks, TASK_FORGED);
  const blocked = input.tasks.blocked ?? 0;
  const launched = total(input.tasks);

  const xp =
    Math.min(input.forges.length, XP.forgeCap) * XP.forge +
    (input.claudeConnected ? XP.claude : 0) +
    Math.min(input.projects, XP.projectCap) * XP.project +
    Math.min(input.devProjects, XP.devProjectCap) * XP.devProject +
    reviewsDone * XP.review +
    reviewsPublished * XP.reviewPublished +
    forged * XP.forged +
    Math.min(blocked, XP.blockedCap) * XP.blocked +
    (input.bonusXp ?? 0);

  const level = levelFor(xp);
  const levelStart = xpForLevel(level);
  const levelSize = level >= MAX_LEVEL ? 1 : xpForLevel(level + 1) - levelStart;
  const levelXp = level >= MAX_LEVEL ? 1 : xp - levelStart;
  const title = [...TITLES].reverse().find(([from]) => level >= from)![1];

  const quests: Quest[] = [
    { id: "forge", title: "Allumer une forge", hint: "Connecte GitHub ou GitLab avec un jeton (Paramètres > Connexion).", done: input.forges.length > 0, xp: XP.forge, action: "settings" },
    { id: "claude", title: "Réveiller l'apprenti", hint: "Connecte ton abonnement Claude avec le terminal (Paramètres > Connexion).", done: input.claudeConnected, xp: XP.claude, action: "terminal" },
    { id: "project", title: "Poser l'enclume", hint: "Ajoute un projet à surveiller (Paramètres > Projets).", done: input.projects > 0, xp: XP.project, action: "settings" },
    { id: "dev", title: "Donner le marteau", hint: "Active l'agent dev sur un projet, avec ses branches et ses commandes de test.", done: input.devProjects > 0, xp: XP.devProject, action: "settings" },
    { id: "task", title: "Confier un ticket à l'apprenti", hint: "Dans l'onglet Tickets, clique sur « Traiter avec l'agent ».", done: launched > 0, xp: XP.forged, action: "tickets" },
    { id: "review", title: "Contrôler une lame", hint: "Laisse l'agent relire une demande de fusion : elle apparaît dans l'onglet Reviews.", done: reviewsDone > 0, xp: XP.review, action: "reviews" },
  ];
  const next = quests.find((quest) => !quest.done);

  const achievements: Achievement[] = [
    { id: "first_forge", title: "Première braise", description: "Une forge est connectée.", unlocked: input.forges.length > 0 },
    { id: "two_forges", title: "Double forge", description: "GitHub et GitLab sont connectés ensemble.", unlocked: input.forges.length >= 2 },
    { id: "awakened", title: "Apprenti réveillé", description: "Claude est connecté à l'outil.", unlocked: input.claudeConnected },
    { id: "first_review", title: "Premier contrôle", description: "Une review est terminée.", unlocked: reviewsDone >= 1 },
    { id: "ten_reviews", title: "Œil de maître", description: "Dix reviews terminées.", unlocked: reviewsDone >= 10 },
    { id: "first_piece", title: "Première pièce forgée", description: "L'agent a ouvert une demande de fusion.", unlocked: forged >= 1 },
    { id: "five_pieces", title: "Atelier en cadence", description: "Cinq pièces forgées.", unlocked: forged >= 5 },
    { id: "curious", title: "Apprenti prudent", description: "L'agent s'est arrêté pour poser une question plutôt que deviner.", unlocked: blocked >= 1 },
    { id: "armory", title: "Armurerie", description: "Cinq projets configurés.", unlocked: input.projects >= 5 },
  ];

  const heroClass = "Forgeron";
  const specialty = reviewsDone + forged === 0 ? "Novice" : reviewsDone >= forged ? "Contrôleur de lames" : "Maître d'œuvre";

  return {
    heroClass,
    specialty,
    title,
    level,
    xp,
    levelXp,
    levelSize,
    percent: Math.min(100, Math.round((levelXp * 100) / levelSize)),
    stats: [
      { label: "Forges allumées", value: input.forges.length },
      { label: "Projets", value: input.projects },
      { label: "Lames contrôlées", value: reviewsDone },
      { label: "Pièces forgées", value: forged },
    ],
    quests,
    rules: [
      `Forge connectée : +${XP.forge} (jusqu'à ${XP.forgeCap} forges)`,
      `Claude connecté : +${XP.claude}`,
      `Projet ajouté : +${XP.project} (jusqu'à ${XP.projectCap} projets)`,
      `Agent dev activé sur un projet : +${XP.devProject} (jusqu'à ${XP.devProjectCap} projets)`,
      `Review terminée : +${XP.review}, et +${XP.reviewPublished} de plus quand elle est publiée`,
      `Pièce forgée (demande de fusion ouverte ou mise à jour par l'agent) : +${XP.forged}`,
      `Ticket où l'agent s'arrête pour poser sa question : +${XP.blocked} (jusqu'à ${XP.blockedCap} fois)`,
      "Palier de maîtrise franchi (pièces forgées, reviews, série de jours, raretés, niveau d'arme) : de l'XP en plus, détaillée au tableau",
    ],
    nextQuest: next?.id ?? null,
    achievements,
  };
}
