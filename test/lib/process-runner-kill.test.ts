import { describe, it, expect } from "vitest";
import os from "node:os";
import { runProcess } from "../../src/lib/process-runner.js";

describe("runProcess kill", () => {
  it.skipIf(process.platform !== "win32")("con shell:true en Windows mata el árbol (no solo cmd.exe)", async () => {
    const t0 = Date.now();
    const { promise, kill } = runProcess({ command: "node", args: ["-e", "setTimeout(()=>{},30000)"], cwd: os.tmpdir(), shell: true });
    await new Promise((r) => setTimeout(r, 300));
    kill();
    await promise;
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 40_000);
});
