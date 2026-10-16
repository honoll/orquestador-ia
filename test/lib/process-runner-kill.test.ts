import { describe, it, expect } from "vitest";
import os from "node:os";
import { runProcess } from "../../src/lib/process-runner.js";

describe("runProcess kill", () => {
  it.skipIf(process.platform !== "win32")("con shell:true en Windows mata el árbol (no solo cmd.exe)", async () => {
    const { promise, kill } = runProcess({ command: "node", args: ["-e", "setTimeout(()=>{},30000)"], cwd: os.tmpdir(), shell: true });
    await new Promise((r) => setTimeout(r, 300));
    // Medido desde el kill: si solo muriera cmd.exe, el nieto node tendría la tubería abierta 30 s.
    // 15 s y no 5: con la suite completa taskkill /T llega a tardar más de 5 s en Windows.
    const t0 = Date.now();
    kill();
    await promise;
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 40_000);
});
