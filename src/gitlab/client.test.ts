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

describe("client GitLab : fichier joint à un ticket", () => {
  it("envoie le fichier en multipart au projet, avec le jeton, et rend le Markdown de GitLab", async () => {
    const calls = stubFetch(() => reply({ alt: "capture", url: "/uploads/ab12/capture.png", markdown: "![capture](/uploads/ab12/capture.png)" }, 201));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const out = await client().uploadFile(65, "capture.png", bytes);

    expect(out).toEqual({ markdown: "![capture](/uploads/ab12/capture.png)" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v4/projects/65/uploads`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("jeton-de-test");
    const form = calls[0]!.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("capture.png");
    expect(file.size).toBe(4);
  });

  it("un refus de GitLab remonte avec son code, une réponse sans lien est une erreur", async () => {
    stubFetch(() => reply({ message: "403 Forbidden" }, 403));
    await expect(client().uploadFile(65, "a.png", new Uint8Array([1]))).rejects.toThrow(/403/);
    stubFetch(() => reply({ alt: "a" }, 201));
    await expect(client().uploadFile(65, "a.png", new Uint8Array([1]))).rejects.toThrow(/lien du fichier/);
  });
});
