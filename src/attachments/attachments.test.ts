import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentError, LIMITS, checkAttachment, checkTotals, formatSize, sanitizeName } from "./rules.js";
import { createAttachmentStore } from "./store.js";

// Petits fichiers valides, avec leurs vrais premiers octets
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fausse image mais en-tête valide")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]);
const GIF = Buffer.from("GIF89a-contenu");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]);
const PDF = Buffer.from("%PDF-1.7\n%contenu");
const text = (s: string) => Buffer.from(s, "utf8");

async function errorOf(fn: () => unknown): Promise<AttachmentError> {
  try {
    await fn();
  } catch (err) {
    return err as AttachmentError;
  }
  throw new Error("aucune erreur levée");
}

describe("noms de fichiers envoyés par le navigateur", () => {
  it("ne garde que la dernière composante : aucun chemin ne passe", () => {
    expect(sanitizeName("../../etc/passwd.png")).toBe("passwd.png");
    expect(sanitizeName("C:\\Users\\alex\\evil.PNG")).toBe("evil.png");
    expect(sanitizeName("/abs/olu/capture.jpg")).toBe("capture.jpg");
  });
  it("remplace les caractères douteux et garde les accents", () => {
    expect(sanitizeName("Capture d'écran <1>.png")).toBe("Capture d_écran _1_.png");
    expect(sanitizeName("a\u0000b\nc.txt")).toBe("a_b_c.txt");
  });
  it("ne rend jamais un nom vide ni un nom réservé par Windows", () => {
    expect(sanitizeName("")).toBe("fichier");
    expect(sanitizeName("...png")).toBe("fichier.png");
    expect(sanitizeName("con.png")).toBe("_con.png");
    expect(sanitizeName("NUL.txt")).toBe("_NUL.txt");
  });
  it("borne la longueur en gardant l'extension", () => {
    const name = sanitizeName(`${"a".repeat(300)}.csv`);
    expect(name.length).toBe(LIMITS.maxNameChars);
    expect(name.endsWith(".csv")).toBe(true);
  });
});

describe("contrôle d'un fichier", () => {
  it("accepte une image, un PDF et des fichiers texte dont le contenu correspond", () => {
    expect(checkAttachment("a.png", PNG)).toMatchObject({ name: "a.png", kind: "image", mime: "image/png" });
    expect(checkAttachment("a.jpeg", JPG)).toMatchObject({ kind: "image", mime: "image/jpeg" });
    expect(checkAttachment("a.GIF", GIF)).toMatchObject({ name: "a.gif", kind: "image" });
    expect(checkAttachment("a.webp", WEBP)).toMatchObject({ kind: "image" });
    expect(checkAttachment("maquette.pdf", PDF)).toMatchObject({ kind: "pdf", mime: "application/pdf" });
    expect(checkAttachment("regles.csv", text("a;b\n1;é"))).toMatchObject({ kind: "text" });
    expect(checkAttachment("donnees.json", text('{"a":1}'))).toMatchObject({ kind: "text" });
  });
  it("refuse les types qui peuvent porter du code ou qu'on ne sait pas lire", async () => {
    for (const name of ["virus.exe", "page.html", "dessin.svg", "script.js", "tache.sh", "archive.zip", "sans-extension"]) {
      const err = await errorOf(() => checkAttachment(name, text("contenu")));
      expect(err).toBeInstanceOf(AttachmentError);
      expect(err.message).toMatch(/pas accepté/);
    }
  });
  it("refuse une image dont le contenu n'en est pas une, ou qui change de type", async () => {
    expect((await errorOf(() => checkAttachment("fausse.png", text("juste du texte")))).message).toMatch(/vraie image/);
    expect((await errorOf(() => checkAttachment("jpeg-deguise.png", JPG))).message).toMatch(/ne correspond pas/);
    expect((await errorOf(() => checkAttachment("faux.pdf", PNG))).message).toMatch(/vrai PDF/);
  });
  it("refuse un binaire déguisé en texte (octet nul, UTF-8 invalide)", async () => {
    expect((await errorOf(() => checkAttachment("note.txt", Buffer.from([0x61, 0x00, 0x62])))).message).toMatch(/texte lisible/);
    expect((await errorOf(() => checkAttachment("note.csv", Buffer.from([0xff, 0xfe, 0xfd])))).message).toMatch(/texte lisible/);
  });
  it("refuse un fichier vide et un fichier trop gros (413)", async () => {
    expect((await errorOf(() => checkAttachment("vide.txt", Buffer.alloc(0)))).message).toMatch(/vide/);
    const bigImage = await errorOf(() => checkAttachment("grosse.png", Buffer.concat([PNG, Buffer.alloc(LIMITS.maxBinaryBytes)])));
    expect(bigImage.status).toBe(413);
    const bigText = await errorOf(() => checkAttachment("gros.txt", Buffer.alloc(LIMITS.maxTextBytes + 1, 0x61)));
    expect(bigText.status).toBe(413);
  });
  it("vérifie les plafonds d'un ensemble", async () => {
    expect(() => checkTotals(Array.from({ length: LIMITS.maxFiles }, () => ({ size: 10 })))).not.toThrow();
    expect((await errorOf(() => checkTotals(Array.from({ length: LIMITS.maxFiles + 1 }, () => ({ size: 10 }))))).message).toMatch(/Trop de fichiers/);
    expect((await errorOf(() => checkTotals([{ size: LIMITS.maxTotalBytes }, { size: 1 }]))).status).toBe(413);
  });
  it("écrit les poids lisiblement", () => {
    expect(formatSize(900)).toBe("900 o");
    expect(formatSize(2048)).toBe("2 Ko");
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1,5 Mo");
  });
});

describe("stockage des pièces jointes", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ra-attach-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("met un fichier en attente, puis le rattache à une tâche dans l'ordre d'envoi", async () => {
    const store = createAttachmentStore(root, 1);
    const a = await store.stage("capture.png", PNG);
    const b = await store.stage("regles.csv", text("a;b"));
    expect(a).toMatchObject({ name: "capture.png", kind: "image", size: PNG.length });
    expect(await store.list({ task: 7 })).toEqual([]);

    const attached = await store.attach({ task: 7 }, [b.id, a.id]);
    expect(attached.map((f) => f.name)).toEqual(["capture.png", "regles.csv"]); // l'ordre d'envoi, pas celui de la demande
    expect(await readdir(path.join(root, "1", "staging"))).toEqual([]);
    expect(await store.list({ task: 7 })).toHaveLength(2);
  });

  it("refuse un identifiant inventé ou piégé, sans rien déplacer", async () => {
    const store = createAttachmentStore(root, 1);
    const ok = await store.stage("a.png", PNG);
    for (const bad of ["../../x", "..", "a".repeat(20), "zzzzzzzzzzzzzzzzzzzz", ""]) {
      const err = await errorOf(() => store.attach({ task: 1 }, [ok.id, bad]));
      expect(err.status).toBe(404);
    }
    expect(await store.list({ task: 1 })).toEqual([]);
    expect(existsSync(path.join(root, "1", "staging", ok.id))).toBe(true); // le fichier valide n'a pas bougé
  });

  it("le contrôle préalable ne déplace rien et refuse un dépassement avant la création de la tâche", async () => {
    const store = createAttachmentStore(root, 1);
    const ids: string[] = [];
    for (let i = 0; i <= LIMITS.maxFiles; i++) ids.push((await store.stage(`f${i}.txt`, text("x"))).id);
    const err = await errorOf(() => store.check({ task: 3 }, ids));
    expect(err.message).toMatch(/Trop de fichiers/);
    await expect(store.check({ task: 3 }, ids.slice(0, LIMITS.maxFiles))).resolves.toHaveLength(LIMITS.maxFiles);
    expect(await store.list({ task: 3 })).toEqual([]);
  });

  it("compte aussi ce qui est déjà rattaché", async () => {
    const store = createAttachmentStore(root, 1);
    const first: string[] = [];
    for (let i = 0; i < LIMITS.maxFiles; i++) first.push((await store.stage(`f${i}.txt`, text("x"))).id);
    await store.attach({ task: 3 }, first);
    const extra = await store.stage("de-trop.txt", text("x"));
    expect((await errorOf(() => store.attach({ task: 3 }, [extra.id]))).message).toMatch(/Trop de fichiers/);
  });

  it("retire un fichier en attente, et seulement un fichier en attente", async () => {
    const store = createAttachmentStore(root, 1);
    const a = await store.stage("a.png", PNG);
    expect(await store.discard(a.id)).toBe(true);
    expect(await store.discard(a.id)).toBe(false);
    expect(await store.discard("../../etc")).toBe(false);
    const kept = await store.attach({ task: 2 }, [(await store.stage("b.png", PNG)).id]);
    expect(await store.discard(kept[0]!.id)).toBe(false); // un fichier rattaché ne s'efface pas par cette voie
    expect(await store.list({ task: 2 })).toHaveLength(1);
  });

  it("deux espaces ne voient jamais les fichiers l'un de l'autre", async () => {
    const one = createAttachmentStore(root, 1), two = createAttachmentStore(root, 2);
    const a = await one.stage("secret.png", PNG);
    expect((await errorOf(() => two.attach({ task: 1 }, [a.id]))).status).toBe(404);
    expect(await two.discard(a.id)).toBe(false);
    await one.attach({ task: 1 }, [a.id]);
    expect(await two.list({ task: 1 })).toEqual([]);
    await two.remove({ task: 1 });
    expect(await one.list({ task: 1 })).toHaveLength(1);
  });

  it("copie les fichiers d'un ticket vers une tâche sous de nouveaux identifiants", async () => {
    const store = createAttachmentStore(root, 1);
    const ticket = { ticket: { source: "gitlab", projectId: 12, iid: 4 } };
    await store.attach(ticket, [(await store.stage("maquette.png", PNG)).id]);
    const copied = await store.copy(ticket, { task: 9 });
    expect(copied).toHaveLength(1);
    expect(copied[0]!.id).not.toBe((await store.list(ticket))[0]!.id);
    expect((await store.list({ task: 9 })).map((f) => f.name)).toEqual(["maquette.png"]);
    expect(await store.copy({ task: 404 }, { task: 10 })).toEqual([]); // rien à copier : pas d'erreur
  });

  it("pose les fichiers à plat dans un dossier, avec un suffixe pour deux noms identiques", async () => {
    const store = createAttachmentStore(root, 1);
    const a = await store.stage("capture.png", PNG);
    const b = await store.stage("Capture.PNG", Buffer.concat([PNG, Buffer.from("2")]));
    await store.attach({ task: 5 }, [a.id, b.id]);
    const dest = path.join(root, "worktree", ".ra-attachments");
    const placed = await store.materialize({ task: 5 }, dest);
    expect(placed.map((f) => f.name)).toEqual(["capture.png", "capture (2).png"]);
    expect((await readdir(dest)).sort()).toEqual(["capture (2).png", "capture.png"]);
    expect((await readFile(placed[1]!.path)).length).toBe(PNG.length + 1);
    expect(await store.materialize({ task: 999 }, path.join(root, "autre"))).toEqual([]);
    expect(existsSync(path.join(root, "autre"))).toBe(false); // rien à poser : aucun dossier créé
  });

  it("supprime les fichiers d'une tâche", async () => {
    const store = createAttachmentStore(root, 1);
    await store.attach({ task: 6 }, [(await store.stage("a.png", PNG)).id]);
    await store.remove({ task: 6 });
    expect(await store.list({ task: 6 })).toEqual([]);
    await store.remove({ task: 6 }); // déjà supprimé : sans erreur
  });

  it("refuse un propriétaire qui ferait sortir d'un dossier", async () => {
    const store = createAttachmentStore(root, 1);
    for (const bad of [{ task: -1 }, { task: 0 }, { task: 1.5 }, { ticket: { source: "../x", projectId: 1, iid: 1 } }, { ticket: { source: "gitlab", projectId: 1, iid: 0 } }]) {
      expect(await errorOf(() => store.list(bad))).toBeInstanceOf(AttachmentError);
    }
    expect(() => createAttachmentStore(root, 0)).toThrow(/Espace invalide/);
  });

  it("limite les fichiers en attente (429) et purge les anciens", async () => {
    const store = createAttachmentStore(root, 1);
    for (let i = 0; i < LIMITS.maxStaged; i++) await store.stage(`f${i}.txt`, text("x"));
    expect((await errorOf(() => store.stage("un-de-trop.txt", text("x")))).status).toBe(429);
    // Un fichier vieux de plus d'un jour est supprimé à l'envoi suivant
    const dir = path.join(root, "1", "staging");
    const old = new Date(Date.now() - LIMITS.stagedTtlMs - 60_000);
    for (const id of await readdir(dir)) await utimes(path.join(dir, id), old, old);
    await expect(store.stage("neuf.txt", text("x"))).resolves.toMatchObject({ name: "neuf.txt" });
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("refuse un fichier invalide dès l'envoi, sans rien écrire", async () => {
    const store = createAttachmentStore(root, 1);
    expect(await errorOf(() => store.stage("virus.exe", text("MZ")))).toBeInstanceOf(AttachmentError);
    expect(existsSync(path.join(root, "1"))).toBe(false);
  });
});
