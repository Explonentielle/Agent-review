import { describe, expect, it } from "vitest";
import type { DevTaskRepo } from "../db/devTasks.js";
import { Journal } from "./journal.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Faux dépôt dont les écritures durent un temps aléatoire, comme un serveur PostgreSQL chargé. */
function slowRepo(log: string[], options: { failOn?: string } = {}): DevTaskRepo {
  return {
    async addEvent(_taskId: number, kind: string, text: string) {
      await sleep(Math.random() * 12);
      if (text === options.failOn) throw new Error("base indisponible");
      log.push(`${kind}:${text}`);
    },
    async update(_taskId: number, fields: Record<string, unknown>) {
      await sleep(Math.random() * 12);
      log.push(`update:${JSON.stringify(fields)}`);
    },
  } as unknown as DevTaskRepo;
}

describe("journal d'une tâche de dev", () => {
  it("écrit dans l'ordre demandé, même depuis des callbacks synchrones qui n'attendent pas", async () => {
    const log: string[] = [];
    const journal = new Journal(slowRepo(log), 1);

    void journal.step("début");
    for (let i = 1; i <= 25; i++) void journal.event("tool", `outil ${i}`);
    void journal.update({ session_id: "s1" });
    void journal.event("text", "fin");
    await journal.flush();

    expect(log).toEqual(["step:début", ...Array.from({ length: 25 }, (_, i) => `tool:outil ${i + 1}`), 'update:{"session_id":"s1"}', "text:fin"]);
  });

  it("une écriture qui échoue n'empêche ni les suivantes ni l'attente de la fin", async () => {
    const log: string[] = [];
    const journal = new Journal(slowRepo(log, { failOn: "perdu" }), 1);

    void journal.event("tool", "avant");
    void journal.event("tool", "perdu");
    void journal.event("tool", "après");
    await expect(journal.flush()).resolves.toBeUndefined();

    expect(log).toEqual(["tool:avant", "tool:après"]);
  });

  it("attendre une étape attend aussi tout ce qui la précède", async () => {
    const log: string[] = [];
    const journal = new Journal(slowRepo(log), 1);

    void journal.event("tool", "a");
    void journal.event("tool", "b");
    await journal.step("c");

    expect(log).toEqual(["tool:a", "tool:b", "step:c"]);
  });
});
