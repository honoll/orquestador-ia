import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgyArgs as srcBuildAgyArgs, buildAgyStdin as srcBuildAgyStdin } from "../../src/adapters/agy/execute.js";
import {
  buildAgyArgs,
  buildAgyStdin,
  checkKey,
  createBusy,
  parseRunBody,
  resolveCwd,
  withoutSecrets,
} from "../../scripts/agy-worker/worker-core.mjs";

const KEY = "a".repeat(64);

describe("checkKey", () => {
  it("acepta la llave correcta", () => {
    expect(checkKey(`Bearer ${KEY}`, KEY)).toBe(true);
  });
  it("rechaza llave incorrecta, de otro largo, sin Bearer o ausente", () => {
    expect(checkKey(`Bearer ${"b".repeat(64)}`, KEY)).toBe(false);
    expect(checkKey(`Bearer ${KEY}x`, KEY)).toBe(false);
    expect(checkKey(KEY, KEY)).toBe(false);
    expect(checkKey(undefined, KEY)).toBe(false);
    expect(checkKey("", KEY)).toBe(false);
  });
  it("nunca acepta si la llave configurada está vacía", () => {
    expect(checkKey("Bearer ", "")).toBe(false);
  });
});

describe("resolveCwd", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agyw-root-")));
  const inside = path.join(root, "proyecto");
  fs.mkdirSync(inside);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agyw-out-")));

  it("acepta la raíz y carpetas dentro", () => {
    expect(resolveCwd(root, root)).toBe(root);
    expect(resolveCwd(inside, root)).toBe(inside);
  });
  it("rechaza carpetas fuera, relativas, inexistentes o con ..", () => {
    expect(resolveCwd(outside, root)).toBeNull();
    expect(resolveCwd("proyecto", root)).toBeNull();
    expect(resolveCwd(path.join(root, "no-existe"), root)).toBeNull();
    expect(resolveCwd(`${inside}${path.sep}..${path.sep}proyecto`, root)).toBeNull();
    expect(resolveCwd(`${root}-hermano`, root)).toBeNull();
    expect(resolveCwd(undefined, root)).toBeNull();
  });
  it("rechaza un enlace (junction) que apunta fuera de la raíz", () => {
    const link = path.join(root, "enlace");
    fs.symlinkSync(outside, link, "junction");
    expect(resolveCwd(link, root)).toBeNull();
  });
});

describe("args de agy", () => {
  it("son idénticos a buildAgyArgs del adaptador (readOnly true/false)", () => {
    for (const readOnly of [true, false]) {
      expect(buildAgyArgs("gemini-3.8-flash-low", undefined, { readOnly })).toEqual(
        srcBuildAgyArgs("gemini-3.8-flash-low", undefined, { readOnly }),
      );
    }
    expect(buildAgyArgs(undefined, undefined, {})).toEqual(srcBuildAgyArgs(undefined, undefined, {}));
    expect(buildAgyArgs("m", undefined, { readOnly: true })).not.toContain("--dangerously-skip-permissions");
  });
  it("stdin idéntico a buildAgyStdin", () => {
    expect(buildAgyStdin('hola "mundo" & %X%')).toBe(srcBuildAgyStdin('hola "mundo" & %X%'));
  });
});

describe("withoutSecrets", () => {
  it("quita TYPESAFE_API_KEY sin importar mayúsculas", () => {
    expect(withoutSecrets({ typesafe_api_key: "x", PATH: "p" })).toEqual({ PATH: "p" });
  });
});

describe("parseRunBody", () => {
  it("valida prompt, readOnly por defecto true y tope de tiempo", () => {
    expect(parseRunBody({ prompt: "hola", cwd: "C:\\x" })).toEqual({
      prompt: "hola", cwd: "C:\\x", model: undefined, readOnly: true, timeoutSec: 1800,
    });
    expect(parseRunBody({ prompt: "h", cwd: "c", readOnly: false, timeoutSec: 60, model: "m" })).toMatchObject({
      readOnly: false, timeoutSec: 60, model: "m",
    });
    expect(parseRunBody({ prompt: "", cwd: "c" })).toBeNull();
    expect(parseRunBody({ prompt: "h", cwd: "c", timeoutSec: 1801 })).toBeNull();
    expect(parseRunBody({ prompt: "h", cwd: "c", readOnly: "no" })).toBeNull();
    expect(parseRunBody(null)).toBeNull();
  });
});

describe("createBusy", () => {
  it("solo un paso a la vez", () => {
    const b = createBusy();
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    b.release();
    expect(b.tryAcquire()).toBe(true);
  });
});
