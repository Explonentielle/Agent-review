import { describe, expect, it } from "vitest";
import { roomQuests, roomXp } from "./hero.js";

describe("quête de l'atelier : dessiner une salle", () => {
  it("n'est accomplie qu'une fois une salle gardée, et mène à l'Architecte", () => {
    const [none] = roomQuests(0);
    expect(none).toMatchObject({ id: "room", done: false, action: "architect", xp: 40 });
    expect(none!.hint).toMatch(/Architecte/);
    expect(roomQuests(1)[0]!.done).toBe(true);
    expect(roomQuests(7)[0]!.done).toBe(true);
  });

  it("rapporte de l'XP par salle gardée, plafonnée à trois salles", () => {
    expect(roomXp(0)).toBe(0);
    expect(roomXp(1)).toBe(40);
    expect(roomXp(3)).toBe(120);
    expect(roomXp(20)).toBe(120);
    expect(roomXp(-4)).toBe(0);
  });
});
