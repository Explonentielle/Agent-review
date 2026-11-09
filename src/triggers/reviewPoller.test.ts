import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeRequest } from "../connectors/types.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { startReviewPoller } from "./reviewPoller.js";

describe("poller de reviews", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const cr = (iid: number, over: Partial<ChangeRequest> = {}): ChangeRequest => ({
    projectId: 1,
    projectPath: "groupe/projet",
    iid,
    title: `MR ${iid}`,
    description: null,
    state: "opened",
    draft: false,
    sourceBranch: `feature/${iid}`,
    targetBranch: "develop",
    headSha: String(iid).padStart(40, "a"),
    url: `https://forge.example/groupe/projet/-/merge_requests/${iid}`,
    author: { id: 9, username: "collegue", name: "Collègue" },
    reviewers: [],
    labels: [],
    ...over,
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ignore les brouillons et ses propres MR, ne relance pas une MR déjà vue, relance sur un nouveau commit", async () => {
    const ok = cr(1);
    h.connector.reviewRequests = [cr(2, { draft: true }), cr(3, { author: { id: 7, username: "alex", name: "Alex" } }), ok];
    const enqueued: number[] = [];
    const stop = startReviewPoller({ connector: h.connector, reviews: h.reviews, username: "alex", intervalMs: 25, enqueue: (id) => enqueued.push(id) });

    await wait(120); // plusieurs cycles : la même MR au même commit n'est reviewée qu'une fois
    expect(enqueued).toHaveLength(1);
    const row = (await h.reviews.get(enqueued[0]!))!;
    expect(row).toMatchObject({ project_id: 1, project_path: "groupe/projet", mr_iid: 1, mr_title: "MR 1", author: "Collègue", head_sha: ok.headSha });

    ok.headSha = "b".repeat(40); // nouveau push sur la MR
    await wait(120);
    stop();
    expect(enqueued).toHaveLength(2);
    expect((await h.reviews.get(enqueued[1]!))!.head_sha).toBe("b".repeat(40));
  });

  it("une erreur de la forge n'arrête pas le poller", async () => {
    let calls = 0;
    h.connector.listReviewRequests = async () => {
      calls++;
      if (calls === 1) throw new Error("forge indisponible");
      return [cr(5)];
    };
    const enqueued: number[] = [];
    const stop = startReviewPoller({ connector: h.connector, reviews: h.reviews, username: "alex", intervalMs: 25, enqueue: (id) => enqueued.push(id) });
    await wait(120);
    stop();
    expect(calls).toBeGreaterThan(1);
    expect(enqueued).toHaveLength(1);
  });
});
