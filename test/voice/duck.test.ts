import { describe, it, expect } from "vitest";
import {
  browserProcessNames,
  BROWSER_ALLOWLIST,
  createDucker,
  duckEnabled,
  duckLevel,
  type HelperProc,
} from "../../src/voice/duck.js";

class FakeHelper implements HelperProc {
  sent: Array<Record<string, unknown>> = [];
  lineCb: (l: string) => void = () => {};
  exitCb: () => void = () => {};
  closed = false;
  reply: (req: Record<string, unknown>) => object | null = () => ({ ok: true, active: [] });
  send(line: string) {
    const req = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(req);
    const r = this.reply(req);
    if (r) queueMicrotask(() => this.lineCb(JSON.stringify(r)));
  }
  onLine(cb: (l: string) => void) {
    this.lineCb = cb;
  }
  onExit(cb: () => void) {
    this.exitCb = cb;
  }
  close() {
    this.closed = true;
  }
  kill() {
    this.exitCb();
  }
}

function setup(opts: { platform?: NodeJS.Platform; files?: Record<string, string> } = {}) {
  const helpers: FakeHelper[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const entry = { pid: 7, name: "Spotify", saved: 0.7, ducked: 0.14 };
  const ducker = createDucker({
    platform: opts.platform ?? "win32",
    statePath: "state.json",
    spawnHelper: () => {
      const h = new FakeHelper();
      h.reply = (req) => (req.cmd === "apply" ? { ok: true, active: [entry] } : { ok: true, active: [] });
      helpers.push(h);
      return h;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    fs: {
      write: (p, d) => {
        files[p] = d;
      },
      read: (p) => files[p] ?? null,
      remove: (p) => {
        delete files[p];
      },
    },
    level: () => 0.2,
    enabled: () => true,
  });
  return { ducker, helpers, timers, files, entry };
}

const noFs = { write: () => {}, read: () => null, remove: () => {} };

describe("browserProcessNames", () => {
  const cases: Array<[string, string[]]> = [
    ["Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0", ["firefox"]],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0", ["msedge"]],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36 OPR/110", ["opera"]],
    ["Mozilla/5.0 Claude/1.0 Chrome/130 Electron/33 Safari/537.36", ["claude"]],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36", ["chrome", "brave"]],
  ];
  it.each(cases)("%s", (ua, names) => expect(browserProcessNames(ua)).toEqual(names));
  it("desconocido o vacío -> toda la lista", () => {
    expect(browserProcessNames("curl/8")).toEqual([...BROWSER_ALLOWLIST]);
    expect(browserProcessNames(undefined)).toEqual([...BROWSER_ALLOWLIST]);
  });
});

describe("config perezosa", () => {
  it("VOICE_DUCK", () => {
    expect(duckEnabled({})).toBe(true);
    expect(duckEnabled({ VOICE_DUCK: "0" })).toBe(false);
    expect(duckEnabled({ VOICE_DUCK: "1" })).toBe(true);
  });
  it("VOICE_DUCK_LEVEL con default y clamp", () => {
    expect(duckLevel({})).toBe(0.2);
    expect(duckLevel({ VOICE_DUCK_LEVEL: "0.5" })).toBe(0.5);
    expect(duckLevel({ VOICE_DUCK_LEVEL: "7" })).toBe(1);
    expect(duckLevel({ VOICE_DUCK_LEVEL: "-1" })).toBe(0);
    expect(duckLevel({ VOICE_DUCK_LEVEL: "abc" })).toBe(0.2);
  });
});

describe("createDucker", () => {
  it("no win32 -> no-op sin lanzar helper", async () => {
    const { ducker, helpers } = setup({ platform: "linux" });
    expect(await ducker.acquire("mic")).toEqual({ supported: false, active: [] });
    expect(await ducker.release("mic")).toEqual({ supported: false, active: [] });
    expect(helpers).toHaveLength(0);
  });

  it("mic -> apply con exclude [] y nivel; persiste el estado", async () => {
    const { ducker, helpers, files, entry } = setup();
    const st = await ducker.acquire("mic", ["firefox"]);
    expect(st).toEqual({ supported: true, active: ["mic"] });
    expect(helpers[0].sent).toEqual([{ cmd: "apply", level: 0.2, exclude: [] }]);
    expect(JSON.parse(files["state.json"])).toEqual({ entries: [entry] });
  });

  it("solo speak -> excluye el navegador; solo nombres de la lista", async () => {
    const { ducker, helpers } = setup();
    await ducker.acquire("speak", ["firefox", "evil.exe", "chrome"]);
    expect(helpers[0].sent[0]).toEqual({ cmd: "apply", level: 0.2, exclude: ["firefox", "chrome"] });
  });

  it("mic + speak -> exclude []; al soltar mic vuelve a excluir el navegador", async () => {
    const { ducker, helpers } = setup();
    await ducker.acquire("speak", ["firefox"]);
    await ducker.acquire("mic");
    expect(helpers[0].sent[1]).toEqual({ cmd: "apply", level: 0.2, exclude: [] });
    const st = await ducker.release("mic");
    expect(st.active).toEqual(["speak"]);
    expect(helpers[0].sent[2]).toEqual({ cmd: "apply", level: 0.2, exclude: ["firefox"] });
  });

  it("sin motivos -> restore y borra el archivo", async () => {
    const { ducker, helpers, files } = setup();
    await ducker.acquire("mic");
    await ducker.release("mic");
    expect(helpers[0].sent[1]).toEqual({ cmd: "restore" });
    expect(files["state.json"]).toBeUndefined();
  });

  it("release sin nada activo no lanza el helper", async () => {
    const { ducker, helpers } = setup();
    await ducker.release("speak");
    expect(helpers).toHaveLength(0);
  });

  it("el lease vence y restaura; renovar lo reinicia", async () => {
    const { ducker, helpers, timers } = setup();
    await ducker.acquire("mic");
    expect(timers[0].ms).toBe(45_000);
    await ducker.acquire("mic");
    expect(timers[0].cleared).toBe(true);
    timers.filter((t) => t.ms === 45_000 && !t.cleared)[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(helpers[0].sent.at(-1)).toEqual({ cmd: "restore" });
    expect(ducker.status().active).toEqual([]);
  });

  it("reinicia el helper si murió", async () => {
    const { ducker, helpers } = setup();
    await ducker.acquire("mic");
    helpers[0].kill();
    await ducker.acquire("speak", ["firefox"]);
    expect(helpers).toHaveLength(2);
    expect(helpers[1].sent[0]).toMatchObject({ cmd: "restore" });
    expect(helpers[1].sent[1]).toMatchObject({ cmd: "apply" });
  });

  it("nunca lanza: spawn que falla", async () => {
    const bad = createDucker({
      platform: "win32",
      spawnHelper: () => {
        throw new Error("boom");
      },
      enabled: () => true,
      fs: noFs,
    });
    expect(await bad.acquire("mic")).toEqual({ supported: true, active: ["mic"], error: "boom" });
  });

  it("nunca lanza: la compilación del exe falla -> estado con error y sin spawn", async () => {
    let spawned = 0;
    const bad = createDucker({
      platform: "win32",
      ensureExe: async () => {
        throw new Error("csc no disponible");
      },
      spawnHelper: () => {
        spawned++;
        return new FakeHelper();
      },
      enabled: () => true,
      fs: noFs,
    });
    expect(await bad.acquire("mic")).toEqual({ supported: true, active: ["mic"], error: "csc no disponible" });
    expect(spawned).toBe(0);
  });

  it("spawnHelper recibe la ruta del exe compilado", async () => {
    const seen: string[] = [];
    const d = createDucker({
      platform: "win32",
      ensureExe: async () => "C:/x/duck-helper-abc.exe",
      spawnHelper: (exe) => {
        seen.push(exe);
        const h = new FakeHelper();
        h.reply = () => ({ ok: true, active: [] });
        return h;
      },
      enabled: () => true,
      fs: noFs,
    });
    await d.acquire("mic");
    expect(seen).toEqual(["C:/x/duck-helper-abc.exe"]);
  });

  it("nunca lanza: helper mudo (timeout)", async () => {
    const reqTimers: Array<() => void> = [];
    const mute = createDucker({
      platform: "win32",
      spawnHelper: () => {
        const h = new FakeHelper();
        h.reply = () => null;
        return h;
      },
      setTimer: (fn, ms) => {
        if (ms === 10_000) reqTimers.push(fn);
        return {};
      },
      clearTimer: () => {},
      enabled: () => true,
      fs: noFs,
    });
    const p = mute.acquire("mic");
    await new Promise((r) => setTimeout(r, 0));
    reqTimers[0]();
    await expect(p).resolves.toEqual({ supported: true, active: ["mic"] });
  });

  it("VOICE_DUCK=0 -> no hace nada", async () => {
    const helpers: FakeHelper[] = [];
    const d = createDucker({
      platform: "win32",
      enabled: () => false,
      spawnHelper: () => {
        const h = new FakeHelper();
        helpers.push(h);
        return h;
      },
    });
    expect(await d.acquire("mic")).toEqual({ supported: false, active: [] });
    expect(helpers).toHaveLength(0);
  });

  it("recover: restaura por pid+nombre desde el archivo y lo borra", async () => {
    const entry = { pid: 7, name: "Spotify", saved: 0.7, ducked: 0.14 };
    const { ducker, helpers, files } = setup({
      files: { "state.json": JSON.stringify({ entries: [entry, { bad: 1 }] }) },
    });
    await ducker.recover();
    expect(helpers[0].sent).toEqual([{ cmd: "restore", entries: [entry] }]);
    expect(files["state.json"]).toBeUndefined();
  });

  it("recover: sin archivo no hace nada; archivo corrupto se borra sin helper", async () => {
    const a = setup();
    await a.ducker.recover();
    expect(a.helpers).toHaveLength(0);
    const b = setup({ files: { "state.json": "{no json" } });
    await b.ducker.recover();
    expect(b.helpers).toHaveLength(0);
    expect(b.files["state.json"]).toBeUndefined();
  });

  it("closeHelper cierra stdin (el helper restaura en EOF) y suelta los leases", async () => {
    const { ducker, helpers } = setup();
    await ducker.acquire("mic");
    ducker.closeHelper();
    expect(helpers[0].closed).toBe(true);
    expect(ducker.status().active).toEqual([]);
  });
});

describe("carreras y reinicio del helper (I1/I2)", () => {
  it("acquire -> release rápido antes de que el helper esté listo termina en restore, sin dejar nada atenuado", async () => {
    const helpers: FakeHelper[] = [];
    let open: (p: string) => void = () => {};
    const gate = new Promise<string>((r) => (open = r));
    const d = createDucker({
      platform: "win32",
      ensureExe: () => gate,
      spawnHelper: () => {
        const h = new FakeHelper();
        helpers.push(h);
        return h;
      },
      enabled: () => true,
      fs: noFs,
    });
    const a = d.acquire("mic");
    await new Promise((r) => setTimeout(r, 0));
    const r = d.release("mic");
    open("x.exe");
    await Promise.all([a, r]);
    const cmds = helpers.flatMap((h) => h.sent.map((s) => s.cmd));
    expect(cmds).not.toContain("apply");
    expect(cmds.at(-1)).toBe("restore");
    expect(d.status().active).toEqual([]);
  });

  it("helper nuevo con estado ducked: restaura las entradas guardadas ANTES de aplicar", async () => {
    const { ducker, helpers, files, entry } = setup();
    await ducker.acquire("mic");
    helpers[0].kill(); // el helper muere con Spotify atenuado
    await ducker.acquire("speak", ["firefox"]);
    expect(helpers).toHaveLength(2);
    expect(helpers[1].sent[0]).toEqual({ cmd: "restore", entries: [entry] });
    expect(helpers[1].sent[1]).toMatchObject({ cmd: "apply" });
    expect(JSON.parse(files["state.json"])).toEqual({ entries: [entry] });
  });

  it("helper nuevo + release: restaura las entradas y solo entonces borra el archivo", async () => {
    const { ducker, helpers, files, entry } = setup();
    await ducker.acquire("mic");
    helpers[0].kill();
    await ducker.release("mic");
    expect(helpers[1].sent[0]).toEqual({ cmd: "restore", entries: [entry] });
    expect(files["state.json"]).toBeUndefined();
  });

  it("si la restauración falla, el archivo de estado se conserva y no se aplica encima", async () => {
    const helpers: FakeHelper[] = [];
    const files: Record<string, string> = {};
    const entry = { pid: 7, name: "Spotify", saved: 0.7, ducked: 0.14 };
    let mute = false;
    const d = createDucker({
      platform: "win32",
      statePath: "s.json",
      spawnHelper: () => {
        const h = new FakeHelper();
        h.reply = (req) => (mute ? { ok: false, error: "x" } : req.cmd === "apply" ? { ok: true, active: [entry] } : { ok: true, active: [] });
        helpers.push(h);
        return h;
      },
      enabled: () => true,
      fs: { write: (p, t) => void (files[p] = t), read: (p) => files[p] ?? null, remove: (p) => void delete files[p] },
    });
    await d.acquire("mic");
    helpers[0].kill();
    mute = true;
    await d.release("mic");
    expect(files["s.json"]).toBeDefined();
    expect(helpers[1].sent.map((s) => s.cmd)).toEqual(["restore"]);
  });

  it("recover: conserva el archivo si la restauración falla", async () => {
    const entry = { pid: 7, name: "Spotify", saved: 0.7, ducked: 0.14 };
    const files: Record<string, string> = { "s.json": JSON.stringify({ entries: [entry] }) };
    const d = createDucker({
      platform: "win32",
      statePath: "s.json",
      spawnHelper: () => {
        const h = new FakeHelper();
        h.reply = () => ({ ok: false });
        return h;
      },
      enabled: () => true,
      fs: { write: (p, t) => void (files[p] = t), read: (p) => files[p] ?? null, remove: (p) => void delete files[p] },
    });
    await d.recover();
    expect(files["s.json"]).toBeDefined();
  });

  it("entradas sin sesión que restaurar (missing) siguen en el archivo", async () => {
    const entry = { pid: 7, name: "Spotify", saved: 0.7, ducked: 0.14 };
    const files: Record<string, string> = { "s.json": JSON.stringify({ entries: [entry] }) };
    const d = createDucker({
      platform: "win32",
      statePath: "s.json",
      spawnHelper: () => {
        const h = new FakeHelper();
        h.reply = () => ({ ok: true, active: [{ ...entry, id: "k" }] });
        return h;
      },
      enabled: () => true,
      fs: { write: (p, t) => void (files[p] = t), read: (p) => files[p] ?? null, remove: (p) => void delete files[p] },
    });
    await d.recover();
    expect(JSON.parse(files["s.json"]).entries).toHaveLength(1);
  });
});
