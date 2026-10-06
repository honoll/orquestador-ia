import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCavemanSkill, cavemanFlagFile } from "../../src/lib/caveman.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "cav-")); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const mk = (hash: string, mtime: number) => {
  const dir = path.join(home, ".claude", "plugins", "cache", "caveman", "caveman", hash, "caveman");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "SKILL.md");
  fs.writeFileSync(f, hash);
  fs.utimesSync(f, mtime, mtime);
  return f;
};

describe("caveman", () => {
  it("null si el plugin no está instalado", () => expect(findCavemanSkill(home)).toBeNull());
  it("encuentra el SKILL.md sin conocer el hash", () => {
    const f = mk("abc123", 1000);
    expect(findCavemanSkill(home)).toBe(f);
  });
  it("con varias versiones elige la más reciente", () => {
    mk("vieja", 1000);
    const nueva = mk("nueva", 2000);
    expect(findCavemanSkill(home)).toBe(nueva);
  });
  it("flag file vive en ~/.claude/.caveman-active", () =>
    expect(cavemanFlagFile(home)).toBe(path.join(home, ".claude", ".caveman-active")));
});
