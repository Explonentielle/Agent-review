import { z } from "zod";

/** Un texte affiché dans le jeu : pas de caractère de contrôle, pas de chevrons (aucun HTML, même par erreur). */
export const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "caractère de contrôle interdit")
    .refine((s) => !/[<>]/.test(s), "les chevrons < > ne sont pas autorisés");
