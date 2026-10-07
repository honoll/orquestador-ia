import { describe, it, expect, vi } from "vitest";
import { buildWhisperServerArgs, createWhisper, silentWav, type WhisperDeps } from "../../src/voice/whisper.js";
import { voiceConfig } from "../../src/voice/config.js";

const cfg = voiceConfig({});

const WHISPER_PAGE = "<html><head><title>Whisper.cpp Server</title></head><body><form action=\"/inference\"></form></body></html>";

function makeDeps(
  over: Partial<{ healthyAfter: number; inference: () => Response | Promise<Response>; up: boolean; rootBody: string }> = {},
) {
  let healthCalls = 0;
  // Realista: el puerto está cerrado hasta que se lanza el servidor (salvo `up`: un proceso ya lo ocupa).
  let down = !over.up;
  const exitCbs: Array<() => void> = [];
  const kill = vi.fn();
  const spawnServer = vi.fn((_args: string[]) => (down = false, { kill, onExit: (cb: () => void) => { exitCbs.push(cb); } }));
  const inferenceBodies: FormData[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/inference")) {
      inferenceBodies.push(init?.body as FormData);
      return over.inference ? over.inference() : new Response(JSON.stringify({ text: "  hola mundo \n" }), { status: 200 });
    }
    if (down) throw new Error("ECONNREFUSED");
    healthCalls++;
    if (healthCalls <= (over.healthyAfter ?? 0)) throw new Error("ECONNREFUSED");
    return new Response(over.rootBody ?? WHISPER_PAGE, { status: 200 });
  }) as unknown as typeof fetch;
  const wait = vi.fn(async () => {});
  const deps: WhisperDeps = { spawnServer, fetchImpl, wait, exists: () => true };
  return { deps, spawnServer, fetchImpl, wait, kill, exitCbs, inferenceBodies, setDown: (v: boolean) => { down = v; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("buildWhisperServerArgs", () => {
  it("args exactos, solo 127.0.0.1", () => {
    expect(buildWhisperServerArgs(cfg)).toEqual(["-m", cfg.whisperModel, "--host", "127.0.0.1", "--port", "8091", "-l", "es"]);
  });
});

describe("silentWav", () => {
  it("WAV 16 kHz mono s16 de 1 s", () => {
    const w = silentWav(1);
    expect(w.length).toBe(44 + 32000);
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt16LE(22)).toBe(1);
  });
});

describe("createWhisper", () => {
  it("espera la salud, calienta una vez y queda ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = makeDeps({
      healthyAfter: 3,
      inference: async () => { await gate; return new Response(JSON.stringify({ text: "" }), { status: 200 }); },
    });
    const w = createWhisper(cfg, m.deps);
    expect(w.status()).toBe("stopped");
    expect(await w.ensureStarted()).toBe(true);
    expect(m.wait).toHaveBeenCalledTimes(3);
    expect(m.spawnServer).toHaveBeenCalledWith(buildWhisperServerArgs(cfg));
    expect(w.status()).toBe("warming");
    release();
    await flush();
    expect(w.status()).toBe("ready");
    expect(m.inferenceBodies).toHaveLength(1); // calentamiento
    await w.ensureStarted();
    expect(m.inferenceBodies).toHaveLength(1);
  });

  it("llamadas concurrentes comparten un solo spawn", async () => {
    const m = makeDeps({ healthyAfter: 1 });
    const w = createWhisper(cfg, m.deps);
    const r = await Promise.all([w.ensureStarted(), w.ensureStarted(), w.transcribe(silentWav(1))]);
    expect(r[0]).toBe(true);
    expect(m.spawnServer).toHaveBeenCalledTimes(1);
  });

  it("exe o modelo faltante -> failed y false, sin lanzar", async () => {
    const m = makeDeps();
    m.deps.exists = (p) => p !== cfg.whisperModel;
    const w = createWhisper(cfg, m.deps);
    expect(await w.ensureStarted()).toBe(false);
    expect(w.status()).toBe("failed");
    expect(m.spawnServer).not.toHaveBeenCalled();
    expect(await w.transcribe(Buffer.alloc(10))).toBeNull();
  });

  it("transcribe: {text} -> texto recortado, con campos del formulario", async () => {
    const m = makeDeps();
    const w = createWhisper(cfg, m.deps);
    expect(await w.transcribe(silentWav(1))).toBe("hola mundo");
    const form = m.inferenceBodies.at(-1)!;
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("es");
    expect((form.get("file") as File).type).toBe("audio/wav");
  });

  it("error HTTP o excepción -> null", async () => {
    const m = makeDeps({ inference: () => new Response("x", { status: 500 }) });
    const w = createWhisper(cfg, m.deps);
    expect(await w.transcribe(silentWav(1))).toBeNull();
    const m2 = makeDeps({ inference: () => { throw new Error("timeout"); } });
    expect(await createWhisper(cfg, m2.deps).transcribe(silentWav(1))).toBeNull();
  });

  it("salud nunca responde -> failed y mata el proceso", async () => {
    const m = makeDeps({ healthyAfter: 10_000 });
    const w = createWhisper(cfg, m.deps);
    expect(await w.ensureStarted()).toBe(false);
    expect(w.status()).toBe("failed");
    expect(m.kill).toHaveBeenCalled();
  });

  it("si el proceso muere vuelve a stopped y relanza en la siguiente llamada", async () => {
    const m = makeDeps();
    const w = createWhisper(cfg, m.deps);
    await w.ensureStarted();
    await flush();
    expect(w.status()).toBe("ready");
    m.setDown(true); // el proceso murió: el puerto se libera
    m.exitCbs[0]();
    expect(w.status()).toBe("stopped");
    expect(await w.ensureStarted()).toBe(true);
    expect(m.spawnServer).toHaveBeenCalledTimes(2);
  });

  it("stop() mata el proceso y deja stopped", async () => {
    const m = makeDeps();
    const w = createWhisper(cfg, m.deps);
    await w.ensureStarted();
    w.stop();
    expect(m.kill).toHaveBeenCalledTimes(1);
    expect(w.status()).toBe("stopped");
  });

  it("la configuración se resuelve de forma perezosa (puerto de .env posterior al import)", async () => {
    let current = voiceConfig({});
    const m = makeDeps();
    const w = createWhisper(() => current, m.deps);
    current = voiceConfig({ WHISPER_PORT: "9123" });
    expect(await w.ensureStarted()).toBe(true);
    expect(m.spawnServer).toHaveBeenCalledWith(buildWhisperServerArgs(current));
    expect(String(vi.mocked(m.fetchImpl).mock.calls[0][0])).toContain(":9123");
    await w.transcribe(silentWav(1));
    expect(String(vi.mocked(m.fetchImpl).mock.calls.at(-1)![0])).toBe("http://127.0.0.1:9123/inference");
  });

  it("puerto ocupado por un whisper-server huérfano genuino: lo adopta sin lanzar otro y no lo mata", async () => {
    const m = makeDeps({ up: true });
    const w = createWhisper(cfg, m.deps);
    expect(await w.ensureStarted()).toBe(true);
    expect(m.spawnServer).not.toHaveBeenCalled();
    expect(await w.transcribe(silentWav(1))).toBe("hola mundo");
    w.stop();
    expect(m.kill).not.toHaveBeenCalled();
    expect(w.status()).toBe("stopped");
  });

  it("puerto ocupado por otro servicio: failed con mensaje claro y sin lanzar procesos en bucle", async () => {
    const m = makeDeps({ up: true, rootBody: "<html>nginx</html>" });
    const w = createWhisper(cfg, m.deps);
    for (let i = 0; i < 3; i++) expect(await w.ensureStarted()).toBe(false);
    expect(m.spawnServer).not.toHaveBeenCalled();
    expect(w.status()).toBe("failed");
    expect(w.lastError()).toMatch(/8091.*ocupado/);
    expect(await w.transcribe(silentWav(1))).toBeNull();
  });

  it("stop() durante un arranque en curso no deja una promesa vieja", async () => {
    const m = makeDeps({ healthyAfter: 2 });
    const w = createWhisper(cfg, m.deps);
    const first = w.ensureStarted();
    w.stop();
    expect(await first).toBe(false);
    expect(await w.ensureStarted()).toBe(true);
    expect(m.spawnServer).toHaveBeenCalledTimes(1);
  });
});
