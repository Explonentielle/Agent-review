import { fileURLToPath } from "node:url";

/** Racine du projet (valable depuis src/ via tsx comme depuis dist/ après build). */
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
