import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { OfficeState } from "../../lib/office-state";
import { FLOORS, floorOf } from "../../office/world/maps";
import { findPath, isNear, isSolid, key, zoneAt } from "../../office/world/path";
import { placeAgents, planRoute, type Leg, type Place, type WorldAgent } from "../../office/world/placement";
import { dirBetween, DIR_DELTA, fitScale, keyToDir, moverPos, newMover, screenToTile, tickMover, type Mover } from "../../office/world/input";
import { drawBubble, drawCreature, drawFloor, drawSkin, drawUpper, type Atlas } from "../../office/world/render";
import { loadEscenario } from "../../office/world/escenario";
import { creatureFrame, type Dir } from "../../office/sprites/creatures";
import { EMPTY_SKINS, fetchSkins, resolveSkin, type SkinsConfig } from "../../office/sprites/skins";
import { loadSkinImages, skinSrc } from "../../office/sprites/skin-images";
import type { FloorMap, Tile } from "../../office/world/types";

interface Props {
  state: OfficeState | undefined; onNear: (a: WorldAgent | null) => void;
  /** Enter/Espacio/Z con el foco en el canvas y un agente cerca: avanza el cuadro de diálogo. */
  onAdvance?: () => void;
  /** Cuadro de diálogo: se pinta sobre el canvas y se oculta con el menú del elevador. */
  children?: ReactNode;
}
interface Ent { agent: WorldAgent; place: Place; legs: Leg[]; piso: number; m: Mover; wanderAt: number }

const STEP_MS = 1000 / 60, MAX_STEPS = 4;
const colsOf = (m: FloorMap) => m.filas[0].length;
const DIRS: Dir[] = ["up", "down", "left", "right"];
const lenOf = (legs: Leg[]) => legs.reduce((n, l) => n + l.path.length, 0);
const wanderDelay = () => 120 + Math.floor(Math.random() * 180); // 2–5 s a 60 Hz

function World({ state, onNear, onAdvance, children, atlas }: Props & { atlas: Map<string, Atlas> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;
  const [reduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [piso, setPiso] = useState(1);
  const [menu, setMenu] = useState(false);
  const [scale, setScale] = useState(3);
  const cols = colsOf(floorOf(piso));
  // Estado del mundo en un ref: el bucle lo muta 60 veces por segundo sin pasar por React.
  const w = useRef({
    player: { piso: 1, m: newMover(floorOf(1).salida!, "down"), route: [] as Tile[] },
    agents: new Map<string, Ent>(),
    held: [] as Dir[], shift: false, menu: false, tick: 0, near: null as WorldAgent | null,
    skins: EMPTY_SKINS as SkinsConfig, imgs: new Map<string, HTMLImageElement>(),
  }).current;

  const agentTiles = (p: number, except?: Ent): Set<string> => {
    const s = new Set<string>();
    for (const e of w.agents.values()) if (e.piso === p && e !== except) { s.add(key(e.m.tile)); if (e.m.from) s.add(key(e.m.from)); }
    return s;
  };

  const openMenu = () => { w.menu = true; w.player.route = []; w.held = []; setMenu(true); };
  const choose = (n: number) => {
    const p = w.player, target = n || p.piso;
    p.piso = target; p.m = newMover(floorOf(target).llegada, "down"); p.route = [];
    w.held = []; w.menu = false;
    setMenu(false); setPiso(target);
    canvasRef.current?.focus();
  };
  const onStandE = () => { const { piso: pp, m } = w.player; if (floorOf(pp).filas[m.tile[1]][m.tile[0]] === "E") openMenu(); };

  // Skins del usuario (si no hay, criaturas por código).
  useEffect(() => {
    let alive = true;
    void fetchSkins().then(async (cfg) => { const imgs = await loadSkinImages(cfg); if (alive) { w.skins = cfg; w.imgs = imgs; } });
    return () => { alive = false; };
  }, [w]);

  // Escala entera según el ancho del contenedor.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setScale(fitScale(entry.contentRect.width, cols)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols]);

  // Cada estado nuevo: destino por rol; ruta caminando o teletransporte si no alcanza la animación.
  useEffect(() => {
    if (!state) return;
    const prev = new Map([...w.agents].map(([k, e]) => [k, e.place]));
    const next = new Map<string, Ent>();
    for (const a of placeAgents(state, prev)) {
      const dest: Place = { piso: a.piso, tile: a.tile };
      const e = w.agents.get(a.key);
      const teleport = (): Ent => ({ agent: a, place: dest, legs: [], piso: a.piso, m: newMover(a.tile, e?.m.dir ?? "down"), wanderAt: w.tick + wanderDelay() });
      if (!e || reduced) { next.set(a.key, teleport()); continue; }
      if (e.place.piso === dest.piso && key(e.place.tile) === key(dest.tile)) { next.set(a.key, { ...e, agent: a }); continue; }
      const legs = planRoute({ piso: e.piso, tile: e.m.tile }, dest);
      next.set(a.key, lenOf(legs) > 40 || lenOf(e.legs) > 12 ? teleport() : { ...e, agent: a, place: dest, legs });
    }
    w.agents = next;
  }, [state, reduced, w]);

  // Bucle de paso fijo a 60 Hz sobre requestAnimationFrame; pausado con la pestaña oculta.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const atlasOf = (m: FloorMap) => (m.gen3 ? atlas.get(m.gen3.atlas) : undefined);

    const stepAgents = () => {
      const pl = w.player;
      for (const e of w.agents.values()) {
        if (!e.m.from && e.legs.length) {
          const leg = e.legs[0];
          if (leg.path.length && key(leg.path[0]) === key(e.m.tile)) leg.path.shift();
          if (!leg.path.length) {
            e.legs.shift();
            const nl = e.legs[0];
            if (nl) { e.piso = nl.piso; e.m = newMover(nl.path.shift() ?? floorOf(nl.piso).llegada, "down"); } // sale del elevador
            continue;
          }
        }
        const target = e.legs[0]?.path[0];
        // Deambular: agentes en reposo en la sala de descanso, 1 casilla libre al azar cada 2–5 s.
        if (!target && !e.m.from && !reduced && !e.agent.working && w.tick >= e.wanderAt) {
          e.wanderAt = w.tick + wanderDelay();
          const map = floorOf(e.piso), zone = zoneAt(map, e.m.tile);
          const [dx, dy] = DIR_DELTA[DIRS[Math.floor(Math.random() * 4)]];
          const t: Tile = [e.m.tile[0] + dx, e.m.tile[1] + dy];
          const taken = agentTiles(e.piso, e);
          if (pl.piso === e.piso) taken.add(key(pl.m.tile));
          if (zone?.id === "descanso" && zoneAt(map, t)?.id === "descanso" && !isSolid(map, t[0], t[1], taken) && !"Ed".includes(map.filas[t[1]][t[0]])) {
            e.legs = [{ piso: e.piso, path: [t] }];
          }
          continue;
        }
        const held = target && !e.m.from ? dirBetween(e.m.tile, target) : null; // a media casilla `tile` ya es el destino
        if (held) e.m = { ...e.m, dir: held };
        e.m = tickMover(e.m, held, false, () => false);
      }
    };

    const step = () => {
      w.tick++;
      if (w.menu) return;
      const p = w.player, map = floorOf(p.piso), occ = agentTiles(p.piso);
      const blocked = (t: Tile) => isSolid(map, t[0], t[1], occ);
      let held: Dir | null = w.held.at(-1) ?? null;
      if (!held && p.route.length && !p.m.from) {
        if (key(p.route[0]) === key(p.m.tile)) p.route.shift();
        const nx = p.route[0];
        if (nx && blocked(nx)) p.route = [];
        else if (nx) { held = dirBetween(p.m.tile, nx); p.m = { ...p.m, dir: held }; } // la ruta del clic no espera el giro
      }
      const was = p.m;
      p.m = tickMover(p.m, held, w.shift, blocked);
      if (was.from && !p.m.from && key(was.from) !== key(was.tile)) onStandE();
      stepAgents();
      const near = [...w.agents.values()]
        .filter((e) => e.piso === p.piso && isNear(p.m.tile, e.m.tile))
        .sort((a, b) => a.agent.key.localeCompare(b.agent.key))[0]?.agent ?? null;
      if (near !== w.near) { w.near = near; onNearRef.current(near); }
    };

    const draw = () => {
      const p = w.player, map = floorOf(p.piso), h = map.filas.length * 16;
      if (canvas.width !== colsOf(map) * 16) canvas.width = colsOf(map) * 16;
      if (canvas.height !== h) canvas.height = h;
      ctx.imageSmoothingEnabled = false;
      drawFloor(ctx, map, reduced ? 0 : w.tick, atlasOf(map));
      const people = [
        ...[...w.agents.values()].filter((e) => e.piso === p.piso).map((e) => ({
          m: e.m, working: e.agent.working, kind: e.agent.criatura,
          spec: resolveSkin(w.skins, { agentKey: e.agent.key, account: e.agent.cuenta, rol: e.agent.rol, criatura: e.agent.criatura }),
        })),
        { m: p.m, working: false, kind: "jugador" as const, spec: resolveSkin(w.skins, { player: true, criatura: "jugador" }) },
      ].map((o) => ({ ...o, pos: reduced ? [o.m.tile[0], o.m.tile[1]] : moverPos(o.m) }))
        .sort((a, b) => a.pos[1] - b.pos[1]);
      const bubbles: [number, number][] = [];
      for (const o of people) {
        const px = Math.round(o.pos[0] * 16), py = Math.round(o.pos[1] * 16);
        const img = o.spec ? w.imgs.get(skinSrc(o.spec)) : undefined;
        let top = py - 4;
        if (o.spec && img) top = drawSkin(ctx, img, o.spec, o.m.dir, o.m.step, px, py);
        else drawCreature(ctx, creatureFrame(o.kind, o.m.dir, o.m.step, o.working), px, py);
        if (o.working) bubbles.push([px, top]);
      }
      drawUpper(ctx, map, atlasOf(map));
      for (const [bx, by] of bubbles) drawBubble(ctx, bx, by);
    };

    let raf = 0, last = 0, acc = 0;
    const frame = (now: number) => {
      acc += now - last; last = now;
      let n = 0;
      for (; acc >= STEP_MS && n < MAX_STEPS; n++) { step(); acc -= STEP_MS; }
      if (n === MAX_STEPS) acc = 0; // no "ponerse al día" de golpe
      draw();
      raf = requestAnimationFrame(frame);
    };
    const start = () => { last = performance.now(); acc = 0; raf = requestAnimationFrame(frame); };
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden) start(); };
    document.addEventListener("visibilitychange", onVis);
    if (!document.hidden) start();
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, [w, reduced, atlas]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (w.menu) {
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= FLOORS.length) { e.preventDefault(); choose(Number(e.key)); }
      else if (e.key === "Escape") { e.preventDefault(); choose(0); }
      return;
    }
    w.shift = e.shiftKey;
    if (e.target === canvasRef.current && w.near && ["Enter", " ", "z", "Z"].includes(e.key)) {
      e.preventDefault();
      if (!e.repeat) onAdvance?.();
      return;
    }
    // Solo el canvas mueve al jugador: con el foco en un botón del cuadro, su keyup nunca llegaría al canvas
    // y la tecla quedaría "sostenida" para siempre.
    if (e.target !== canvasRef.current) return;
    const d = keyToDir(e.key);
    if (!d) return;
    if (e.key.startsWith("Arrow")) e.preventDefault();
    if (e.repeat) return;
    w.player.route = [];
    w.held = [...w.held.filter((x) => x !== d), d];
  };
  const onKeyUp = (e: KeyboardEvent) => {
    w.shift = e.shiftKey;
    const d = keyToDir(e.key);
    if (d) w.held = w.held.filter((x) => x !== d);
  };
  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    if (w.menu) return;
    const p = w.player, map = floorOf(p.piso);
    const t = screenToTile(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), colsOf(map), map.filas.length);
    if (!t) return;
    w.held = [];
    const route = findPath(map, p.m.tile, t, agentTiles(p.piso));
    // Clic en un agente de la casilla de al lado: solo voltear a verlo.
    if (!route.length && !p.m.from && Math.abs(t[0] - p.m.tile[0]) + Math.abs(t[1] - p.m.tile[1]) === 1 && agentTiles(p.piso).has(key(t))) {
      p.m = { ...p.m, dir: dirBetween(p.m.tile, t) };
      return;
    }
    if (reduced && route.length) {
      const end = route[route.length - 1];
      p.m = newMover(end, dirBetween(route[route.length - 2] ?? p.m.tile, end));
      p.route = [];
      onStandE();
    } else p.route = route;
  };

  const map = floorOf(piso);
  return (
    <div ref={wrapRef} className="w-full overflow-hidden" onKeyDown={onKeyDown}>
      <p className="mb-1 font-pixel text-[11px] text-text-secondary">{map.nombre}</p>
      <div className="relative" style={{ width: cols * 16 * scale }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Oficina, ${map.nombre}. Usa clic o flechas para caminar.`}
          className="block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{ width: cols * 16 * scale, height: map.filas.length * 16 * scale, imageRendering: "pixelated" }}
          onKeyUp={onKeyUp}
          onBlur={() => { w.held = []; w.shift = false; }}
          onClick={onClick}
        />
        {/* Etiquetas de zona en DOM (fuente de la app): en el canvas salían borrosas al escalar. */}
        {map.zonas.map((z) => (
          <span
            key={z.id} aria-hidden="true"
            className="pointer-events-none absolute whitespace-nowrap font-pixel leading-none"
            style={{ left: (z.x * 16 + 2) * scale, top: (z.y * 16 + 2) * scale, fontSize: Math.max(8, 5 * scale), color: z.color }}
          >{z.etiqueta}</span>
        ))}
        {!menu && children}
        {menu && (
          <div role="group" aria-label="Elevador" className="px-panel absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-1 border-zinc-200! bg-[#0b0b10]! p-3 font-pixel text-[12px]">
            <p className="mb-1 text-warn">ELEVADOR</p>
            {FLOORS.map((f) => (
              <button key={f.piso} autoFocus={f.piso === 1} className="px-2 py-1 text-left hover:bg-white/10 focus-visible:bg-white/10" onClick={() => choose(f.piso)}>
                {f.nombre}
              </button>
            ))}
            <button className="px-2 py-1 text-left text-text-secondary hover:bg-white/10 focus-visible:bg-white/10" onClick={() => choose(0)}>salir</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** El escenario propio (si hay) reemplaza los pisos antes de crear el mundo: el jugador nace en su salida. */
export function OfficeWorld(props: Props) {
  const [atlas, setAtlas] = useState<Map<string, Atlas> | null>(null);
  useEffect(() => {
    let alive = true;
    void loadEscenario().then((a) => { if (alive) setAtlas(a); });
    return () => { alive = false; };
  }, []);
  if (!atlas) return <p className="font-pixel text-[11px] text-text-secondary">cargando escenario…</p>;
  return <World {...props} atlas={atlas} />;
}
