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
    const stop = startReviewPoller({ connector: h.connector, reviews: h.reviews, settings: h.settings, username: "alex", intervalMs: 25, enqueue: (id) => enqueued.push(id) });

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

  /** Lance le poller sur une liste de demandes, laisse passer quelques cycles, puis l'arrête. */
  async function pollOnce(requests: ChangeRequest[]): Promise<number[]> {
    h.connector.reviewRequests = requests;
    const enqueued: number[] = [];
    const stop = startReviewPoller({ connector: h.connector, reviews: h.reviews, settings: h.settings, username: "alex", intervalMs: 25, enqueue: (id) => enqueued.push(id) });
    await wait(100);
    stop();
    return enqueued;
  }
  const setTrigger = async (reviewTrigger: "all" | "configured" | "manual") => void (await h.settings.save({ ...(await h.settings.get()), reviewTrigger }));

  it("déclenchement manuel : les demandes sont enregistrées « à lancer », rien n'est mis en file, pas de doublon", async () => {
    await setTrigger("manual");
    const enqueued = await pollOnce([cr(1), cr(2)]);

    expect(enqueued).toEqual([]);
    const rows = await h.reviews.list();
    expect(rows.map((r) => [r.mr_iid, r.status]).sort()).toEqual([[1, "detected"], [2, "detected"]]);
    expect(await h.reviews.listInterrupted()).toEqual([]); // un redémarrage ne les lance pas non plus
  });

  it("projets configurés seulement : les autres demandes ne sont pas enregistrées, elles le sont dès que le projet est configuré", async () => {
    await setTrigger("configured");
    const other = cr(2, { projectId: 99, projectPath: "autre/projet" });
    const enqueued = await pollOnce([cr(1), other]); // le projet 1 est configuré par le harnais, pas le 99

    expect(enqueued).toHaveLength(1);
    expect((await h.reviews.list()).map((r) => r.project_id)).toEqual([1]);

    await h.settings.saveProject({ projectId: 99, path: "autre/projet", devEnabled: false, baseBranch: "", targetBranch: "", allowedCommands: [], instructions: "" });
    expect(await pollOnce([cr(1), other])).toHaveLength(1);
    expect((await h.reviews.list()).map((r) => r.project_id).sort()).toEqual([1, 99]);
  });

  it("le réglage est relu à chaque cycle : passer de manuel à automatique s'applique sans redémarrer", async () => {
    await setTrigger("manual");
    h.connector.reviewRequests = [cr(1)];
    const enqueued: number[] = [];
    const stop = startReviewPoller({ connector: h.connector, reviews: h.reviews, settings: h.settings, username: "alex", intervalMs: 25, enqueue: (id) => enqueued.push(id) });
    await wait(80);
    expect(enqueued).toEqual([]);

    await setTrigger("all");
    h.connector.reviewRequests = [cr(1), cr(2)];
    await wait(100);
    stop();
    expect(enqueued).toHaveLength(1); // la nouvelle demande part ; celle déjà détectée attend toujours ton clic
    expect((await h.reviews.list()).map((r) => [r.mr_iid, r.status]).sort()).toEqual([[1, "detected"], [2, "queued"]]);
  });

  it("une erreur de la forge n'arrête pas le poller", async () => {
    let calls = 0;
    h.connector.listReviewRequests = async () => {
      calls++;
      if (calls === 1) throw new Error("forge indisponible");
      return [cr(5)];
    };
    const enqueued: number[] = [];
    const stop = startReviewPoller({ connector: h.connector, reviews: h.reviews, settings: h.settings, username: "alex", intervalMs: 25, enqueue: (id) => enqueued.push(id) });
    await wait(120);
    stop();
    expect(calls).toBeGreaterThan(1);
    expect(enqueued).toHaveLength(1);
  });
});
