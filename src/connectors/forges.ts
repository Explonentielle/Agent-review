/** Forges prises en charge : valeurs de la colonne « source » des tables et de `ForgeConnector.kind`. */
export const FORGE_KINDS = ["gitlab", "github"] as const;

/** Forge des données créées avant la prise en charge de plusieurs forges. */
export const DEFAULT_FORGE = "gitlab" as const;
