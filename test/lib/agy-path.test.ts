import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgyPath } from "../../src/lib/agy-path.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agyp-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveAgyPath", () => {
  it("usa AGY_PATH si existe", () => {
    const f = path.join(dir, "agy.exe");
    fs.writeFileSync(f, "");
    expect(resolveAgyPath({ AGY_PATH: f })).toBe(f);
  });
  it("cae a LOCALAPPDATA (agy/bin/agy.exe)", () => {
    const f = path.join(dir, "agy", "bin", "agy.exe");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
    expect(resolveAgyPath({ LOCALAPPDATA: dir })).toBe(f);
  });
  it("null si no existe ninguno", () => {
    expect(resolveAgyPath({ AGY_PATH: path.join(dir, "no.exe"), LOCALAPPDATA: dir })).toBeNull();
  });
});
