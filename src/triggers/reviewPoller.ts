import type { ForgeConnector } from "../connectors/types.js";
import type { ReviewRepo } from "../db/reviews.js";
import { errorMessage, log } from "../logger.js";

export interface PollerDeps {
  connector: ForgeConnector;
  reviews: ReviewRepo;
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
      let added = 0;
      for (const mr of requests) {
        if (mr.draft || mr.author.username === deps.username) continue;

        const id = await deps.reviews.insertIfNew({
          source: deps.connector.kind,
          projectId: mr.projectId,
          projectPath: mr.projectPath,
          mrIid: mr.iid,
          mrTitle: mr.title,
          mrUrl: mr.url,
          author: mr.author.name,
          headSha: mr.headSha,
        });
        if (id !== null) {
          added++;
          deps.enqueue(id);
        }
      }
      log.debug("poller.tick", { open: requests.length, added });
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
