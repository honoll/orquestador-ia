import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import { runProcess, ORCHESTRATOR_SECRET_ENV } from "../../src/lib/process-runner.js";

const KEY = "TYPESAFE_API_KEY";
const prev = process.env[KEY];
afterEach(() => {
  if (prev === undefined) delete process.env[KEY];
  else process.env[KEY] = prev;
});

const printKey = (env?: Record<string, string>) =>
  runProcess({ command: "node", args: ["-e", `console.log(process.env.${KEY} ?? 'NONE')`], cwd: os.tmpdir(), shell: false, env }).promise;

describe("runProcess: secretos del orquestador", () => {
  it("la lista incluye la llave de JEV", () => {
    expect(ORCHESTRATOR_SECRET_ENV).toContain(KEY);
  });

  it("no pasa la llave de JEV al trabajador", async () => {
    process.env[KEY] = "x";
    const r = await printKey();
    expect(r.stdout.trim()).toBe("NONE");
  }, 20_000);

  it("tampoco si viene en options.env", async () => {
    const r = await printKey({ [KEY]: "x" });
    expect(r.stdout.trim()).toBe("NONE");
  }, 20_000);
});
