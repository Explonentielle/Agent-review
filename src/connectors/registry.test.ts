import { describe, expect, it } from "vitest";
import type { RepoWorkspace } from "../review/workspace.js";
import { FakeConnector } from "../testing/fakeConnector.js";
import { ForgeRegistry, type Forge } from "./registry.js";
import type { ForgeKind } from "./types.js";

const forge = (kind: ForgeKind, username: string): Forge => ({ connector: new FakeConnector({ cloneUrl: "file:///x" }, kind), workspace: {} as RepoWorkspace, username });

describe("registre des forges", () => {
  it("retrouve chaque forge par son genre, avec son connecteur et l'identité de l'utilisateur", () => {
    const registry = new ForgeRegistry([forge("gitlab", "alex"), forge("github", "alex-gh")]);

    expect(registry.get("gitlab").connector.kind).toBe("gitlab");
    expect(registry.get("github").username).toBe("alex-gh");
    expect(registry.has("github")).toBe(true);
    expect(registry.all().map((f) => f.connector.kind)).toEqual(["gitlab", "github"]);
  });

  it("une forge non configurée donne une erreur lisible, jamais undefined", () => {
    const registry = new ForgeRegistry([forge("gitlab", "alex")]);

    expect(registry.has("github")).toBe(false);
    expect(() => registry.get("github")).toThrow("La forge « github » n'est pas configurée");
    expect(() => registry.get("gitea")).toThrow("n'est pas configurée");
    expect(() => registry.get("")).toThrow("n'est pas configurée");
  });

  it("refuse une forge déclarée deux fois, et un registre vide", () => {
    expect(() => new ForgeRegistry([forge("gitlab", "a"), forge("gitlab", "b")])).toThrow("déclarée deux fois");
    expect(() => new ForgeRegistry([])).toThrow("Aucune forge configurée");
  });
});
