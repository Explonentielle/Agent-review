import type { ForgeConnector } from "../connectors/types.js";
import type { ReviewRepo } from "../db/reviews.js";
import { errorMessage, log } from "../logger.js";
import type { SettingsStore } from "../settings/store.js";

export interface PollerDeps {
  connector: ForgeConnector;
  reviews: ReviewRepo;
  /** Réglages de l'espace : le déclenchement des reviews (toutes, projets configurés, manuel) est relu à chaque cycle. */
  settings: SettingsStore;
  username: string;
  intervalMs: number;
  enqueue: (reviewId: number) => void;
}

/**
 * Détecte les MR à reviewer par polling de l'API de la forge.
 *
 * Pourquoi pas un webhook : ton PC/WSL n'est pas joignable depuis la forge, et le webhook projet
 * peut déjà être utilisé par un autre outil. Le passage Draft → Ready fait apparaître la MR ici
 * au cycle suivant.
 *
 * Chaque couple (MR, commit de tête) n'est reviewé qu'une fois : un nouveau push = nouvelle review.
 */
export function startReviewPoller(deps: PollerDeps): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      const requests = await deps.connector.listReviewRequests(deps.username);
      const trigger = (await deps.settings.get()).reviewTrigger;
      let added = 0;
      let skipped = 0;
      for (const mr of requests) {
        if (mr.draft || mr.author.username === deps.username) continue;
        // « Projets configurés » : une MR d'un autre projet n'est même pas enregistrée, elle le sera dès que le projet est configuré
        if (trigger === "configured" && !(await deps.settings.getProject(deps.connector.kind, mr.projectId))) {
          skipped++;
          continue;
        }

        const id = await deps.reviews.insertIfNew({
          source: deps.connector.kind,
          projectId: mr.projectId,
          projectPath: mr.projectPath,
          mrIid: mr.iid,
          mrTitle: mr.title,
          mrUrl: mr.url,
          author: mr.author.name,
          headSha: mr.headSha,
          status: trigger === "manual" ? "detected" : "queued",
        });
        if (id !== null) {
          added++;
          if (trigger !== "manual") deps.enqueue(id); // en manuel, la review attend ton clic
        }
      }
      log.debug("poller.tick", { open: requests.length, added, skipped, trigger });
    } catch (err) {
      log.error("poller.error", { error: errorMessage(err) });
    } finally {
      if (!stopped) timer = setTimeout(tick, deps.intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
