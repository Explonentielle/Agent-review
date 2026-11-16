import { afterEach, describe, expect, it, vi } from "vitest";
import { GitlabClient } from "./client.js";

const BASE = "https://gitlab.example";

interface Call {
  url: string;
  init?: RequestInit;
}

/** Remplace `fetch` : chaque appel est noté, la réponse vient de `responder`. */
function stubFetch(responder: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return responder(url);
    }),
  );
  return calls;
}

const reply = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const client = () => new GitlabClient(BASE, "jeton-de-test");

afterEach(() => vi.unstubAllGlobals());

describe("client GitLab : ticket créé par le Scribe", () => {
  it("assigné à l'utilisateur du jeton (lu une seule fois), avec les étiquettes en une chaîne", async () => {
    const calls = stubFetch((url) => (url.endsWith("/user") ? reply({ id: 42, username: "alex", name: "Alex" }) : reply({ id: 1, iid: 8 }, 201)));
    const c = client();
    await c.createIssue(65, { title: "t", description: "d", labels: ["bug", "Statut::A traiter"] });
    await c.createIssue(65, { title: "u", description: "d" });

    expect(calls.map((x) => `${x.init?.method} ${x.url.replace(BASE + "/api/v4", "")}`)).toEqual(["GET /user", "POST /projects/65/issues", "POST /projects/65/issues"]);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ title: "t", description: "d", labels: "bug,Statut::A traiter", assignee_ids: [42] });
    expect(JSON.parse(String(calls[2]!.init?.body)).assignee_ids).toEqual([42]);
  });

  it("l'utilisateur du jeton illisible : le ticket est créé quand même, sans assigné", async () => {
    const calls = stubFetch((url) => (url.endsWith("/user") ? reply({ message: "401 Unauthorized" }, 401) : reply({ id: 1, iid: 8 }, 201)));
    await client().createIssue(65, { title: "t", description: "d" });
    expect(JSON.parse(String(calls[1]!.init?.body)).assignee_ids).toBeUndefined();
  });

  it("sans assignation demandée, aucune requête sur l'utilisateur", async () => {
    const calls = stubFetch(() => reply({ id: 1, iid: 8 }, 201));
    await client().createIssue(65, { title: "t", description: "d" }, false);
    expect(calls.length).toBe(1);
    expect(JSON.parse(String(calls[0]!.init?.body)).assignee_ids).toBeUndefined();
  });
});
