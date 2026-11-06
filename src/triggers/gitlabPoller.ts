import type { ReviewRepo } from "../db/reviews.js";
import type { GitlabClient } from "../gitlab/client.js";
import { errorMessage, log } from "../logger.js";

export interface PollerDeps {
  gitlab: GitlabClient;
  reviews: ReviewRepo;
  username: string;
  intervalMs: number;
  enqueue: (reviewId: number) => void;
}

/**
 * Détecte les MR à reviewer par polling de l'API GitLab.
 *
 * Pourquoi pas un webhook : ton PC/WSL n'est pas joignable depuis l'instance GitLab, et le
 * webhook projet peut déjà être utilisé par un autre outil. Le passage Draft → Ready fait
 * apparaître la MR ici au cycle suivant.
 *
 * Chaque couple (MR, commit de tête) n'est reviewé qu'une fois : un nouveau push = nouvelle review.
 */
export function startGitlabPoller(deps: PollerDeps): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      const mrs = await deps.gitlab.listReviewRequests(deps.username);
      let added = 0;
      for (const mr of mrs) {
        if (mr.draft || mr.author.username === deps.username) continue;

        const id = deps.reviews.insertIfNew({
          projectId: mr.project_id,
          projectPath: mr.references.full.replace(/!\d+$/, ""),
          mrIid: mr.iid,
          mrTitle: mr.title,
          mrUrl: mr.web_url,
          author: mr.author.name,
          headSha: mr.sha,
        });
        if (id !== null) {
          added++;
          deps.enqueue(id);
        }
      }
      log.debug("poller.tick", { open: mrs.length, added });
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
