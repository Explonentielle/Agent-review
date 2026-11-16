import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubClient, GithubError, isRepoFullName } from "./client.js";

const BASE = "https://api.github.com";

interface Call {
  url: string;
  init?: RequestInit;
}

/** Remplace `fetch` : chaque appel est noté, la réponse vient de `responder`. */
function stubFetch(responder: (url: string, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init);
    }),
  );
  return calls;
}

const reply = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const client = () => new GithubClient(BASE, "jeton-de-test");

afterEach(() => vi.unstubAllGlobals());

describe("client GitHub : transport", () => {
  it("envoie le jeton, la version de l'API et un User-Agent, sans Content-Type quand il n'y a pas de corps", async () => {
    const calls = stubFetch(() => reply({ id: 1, login: "alex" }));
    await client().getCurrentUser();

    expect(calls[0]!.url).toBe(`${BASE}/user`);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toEqual({
      Authorization: "Bearer jeton-de-test",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "review-agent",
    });
  });

  it("écriture : corps JSON et Content-Type", async () => {
    const calls = stubFetch(() => reply({ id: 5 }, 201));
    await client().createIssueComment("acme/projet", 7, "Bonjour");

    expect(calls[0]!.url).toBe(`${BASE}/repos/acme/projet/issues/7/comments`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ body: "Bonjour" }));
    expect((calls[0]!.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("une réponse sans contenu (204) ne casse pas", async () => {
    stubFetch(() => reply(null, 204));
    await expect(client().addIssueLabels("acme/projet", 7, ["bug"])).resolves.toBeUndefined();
  });

  it("une erreur HTTP lève GithubError avec le statut et le message de GitHub", async () => {
    stubFetch(() => reply({ message: "Bad credentials" }, 401));
    const err = await client().getCurrentUser().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).status).toBe(401);
    expect((err as GithubError).message).toContain("Bad credentials");
    expect((err as GithubError).message).not.toContain("jeton-de-test");
  });

  it("une ressource introuvable (404) donne null ou false, jamais une exception", async () => {
    stubFetch(() => reply({ message: "Not Found" }, 404));
    expect(await client().getIssue("acme/projet", 99)).toBeNull();
    expect(await client().branchExists("acme/projet", "feature/x")).toBe(false);
    await expect(client().removeIssueLabel("acme/projet", 7, "absent")).resolves.toBeNull();
  });

  it("mais une autre erreur sur ces mêmes appels reste une exception", async () => {
    stubFetch(() => reply({ message: "Server Error" }, 500));
    await expect(client().getIssue("acme/projet", 99)).rejects.toBeInstanceOf(GithubError);
    await expect(client().branchExists("acme/projet", "feature/x")).rejects.toBeInstanceOf(GithubError);
  });
});

describe("client GitHub : pagination", () => {
  it("suit le header Link jusqu'à la dernière page, 100 éléments par page", async () => {
    const calls = stubFetch((url) =>
      url.includes("page=2") ? reply([{ number: 3 }]) : reply([{ number: 1 }, { number: 2 }], 200, { link: `<${BASE}/issues?filter=assigned&page=2>; rel="next", <${BASE}/issues?page=2>; rel="last"` }),
    );
    const issues = await client().listAssignedIssues();

    expect(issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${BASE}/issues?filter=assigned&state=open&sort=updated&per_page=100`);
  });

  it("ne suit jamais un lien vers un autre serveur : le jeton n'en sort pas", async () => {
    const calls = stubFetch(() => reply([{ number: 1 }], 200, { link: '<https://pirate.example/collecte?page=2>; rel="next"' }));
    await client().listAssignedIssues();

    expect(calls).toHaveLength(1);
  });

  it("s'arrête au nombre de pages demandé même si GitHub en annonce davantage", async () => {
    let page = 0;
    const calls = stubFetch(() => reply([{ id: ++page }], 200, { link: `<${BASE}/user/repos?page=${page + 1}>; rel="next"` }));
    const repos = await client().listAccessibleRepos();

    expect(calls).toHaveLength(3);
    expect(repos).toHaveLength(3);
  });

  it("les réponses en objet (check-runs, recherche) sont dépliées", async () => {
    stubFetch((url) => (url.includes("check-runs") ? reply({ total_count: 1, check_runs: [{ name: "phpunit", status: "completed", conclusion: "success" }] }) : reply({ total_count: 1, items: [{ number: 4, repository_url: `${BASE}/repos/acme/projet` }] })));

    expect(await client().getCheckRuns("acme/projet", "a".repeat(40))).toEqual([{ name: "phpunit", status: "completed", conclusion: "success" }]);
    expect(await client().searchReviewRequests("alex")).toEqual([{ number: 4, repository_url: `${BASE}/repos/acme/projet` }]);
  });
});

describe("client GitHub : garde-fous sur les entrées", () => {
  it("refuse un nom de dépôt qui pourrait sortir du chemin d'API, sans appeler le réseau", async () => {
    const calls = stubFetch(() => reply({}));

    for (const bad of ["../../user", "acme", "acme/projet/extra", "acme/pro jet", "acme/projet?x=1", ""]) {
      await expect(async () => client().getRepo(bad)).rejects.toThrow("Nom de dépôt invalide");
    }
    expect(calls).toHaveLength(0);
    expect(isRepoFullName("acme/mon-projet_2.0")).toBe(true);
  });

  it("refuse un identifiant GitHub qui injecterait d'autres critères de recherche", async () => {
    const calls = stubFetch(() => reply({ items: [] }));

    await expect(client().searchReviewRequests("alex draft:true")).rejects.toThrow("Identifiant GitHub invalide");
    await expect(client().searchReviewRequests("")).rejects.toThrow("Identifiant GitHub invalide");
    expect(calls).toHaveLength(0);
    await client().searchReviewRequests("dependabot[bot]");
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe("is:pr is:open draft:false review-requested:dependabot[bot]");
  });

  it("encode chaque segment d'un nom de branche et garde les barres obliques", async () => {
    const calls = stubFetch(() => reply({ name: "x" }));
    await client().branchExists("acme/projet", "feature/609 import#1");

    expect(calls[0]!.url).toBe(`${BASE}/repos/acme/projet/branches/feature/609%20import%231`);
  });

  it("branches protégées : filtre côté GitHub", async () => {
    const calls = stubFetch(() => reply([{ name: "main", protected: true }]));
    await client().listBranches("acme/projet", true);

    expect(calls[0]!.url).toBe(`${BASE}/repos/acme/projet/branches?protected=true&per_page=100`);
  });

  it("review : le commit relu est transmis", async () => {
    const calls = stubFetch(() => reply({ id: 1 }));
    await client().createReview("acme/projet", 7, { event: "APPROVE", commit_id: "b".repeat(40) });

    expect(calls[0]!.url).toBe(`${BASE}/repos/acme/projet/pulls/7/reviews`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ event: "APPROVE", commit_id: "b".repeat(40) });
  });
});

describe("client GitHub : fusion d'une PR", () => {
  it("fusion : le commit relu est transmis (GitHub refuse en 409 si la tête a bougé), fusion normale", async () => {
    const calls = stubFetch(() => reply({ merged: true }));
    await client().mergePull("acme/projet", 7, "c".repeat(40));

    expect(calls[0]!.url).toBe(`${BASE}/repos/acme/projet/pulls/7/merge`);
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ sha: "c".repeat(40), merge_method: "merge" });
  });

  it("un refus de fusion (droits, conflit, tête changée) remonte avec son code", async () => {
    stubFetch(() => reply({ message: "Head branch was modified" }, 409));
    await expect(client().mergePull("acme/projet", 7, "c".repeat(40))).rejects.toThrow(GithubError);
    stubFetch(() => reply({ message: "Not Allowed" }, 405));
    await expect(client().mergePull("acme/projet", 7, "c".repeat(40))).rejects.toMatchObject({ status: 405 });
  });

  it("sortie du brouillon : mutation GraphQL avec l'identifiant global de la PR", async () => {
    const calls = stubFetch(() => reply({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }));
    await client().markPullReady("PR_kwDOabc");

    expect(calls[0]!.url).toBe(`${BASE}/graphql`);
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body)) as { query: string; variables: { id: string } };
    expect(body.variables).toEqual({ id: "PR_kwDOabc" });
    expect(body.query).toContain("markPullRequestReadyForReview");
  });

  it("GitHub Enterprise : l'adresse GraphQL se déduit de /api/v3", async () => {
    const calls = stubFetch(() => reply({ data: {} }));
    await new GithubClient("https://ghe.example/api/v3", "jeton").markPullReady("PR_x");
    expect(calls[0]!.url).toBe("https://ghe.example/api/graphql");
  });

  it("GraphQL répond 200 avec des erreurs : c'est un échec, pas un succès", async () => {
    stubFetch(() => reply({ errors: [{ message: "Resource not accessible by personal access token" }] }));
    await expect(client().markPullReady("PR_x")).rejects.toThrow(/Resource not accessible/);
  });
});
