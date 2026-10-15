import { ROLES, type AgentId } from "../../lib/office";
import { roleColor } from "../../lib/roles";
import type { AgySeat, OfficeState } from "../../lib/office-state";
import { FLOORS, floorOf } from "./maps";
import { findPath, freeTileIn, isSolid, key, zoneAt, zoneSeats } from "./path";
import type { Tile } from "./types";

export type CreatureKind = "jugador" | "jefe" | "guardia" | "recepcion" | "biblio" | "claude" | "codex" | "agy" | "dev" | "qa" | "imagen" | "investigador" | "lector" | "redactor";
export interface Place { piso: number; tile: Tile }
export interface Leg { piso: number; path: Tile[] }
export interface WorldAgent {
  key: string; nombre: string; rol: string | null; cuenta: string | null; color: string; criatura: CreatureKind;
  working: boolean; paused: boolean; activity: string; model: string | null; tokens: number | null;
  planId: string | null; stepKey: string | null; progress: { done: number; total: number } | null;
  piso: number; tile: Tile;
}

const ROLE_ZONES = ["dev", "qa", "imagen", "investigador", "lector", "redactor"] as const;
const FIXED: readonly AgentId[] = ["jefe", "guardia", "recepcion", "biblio", "claude", "codex"];
const isRoleZone = (r: string | null): r is string => r !== null && (ROLE_ZONES as readonly string[]).includes(r);

export function zoneForSeat(seat: AgySeat): string {
  if (!seat.working) return "descanso";
  return isRoleZone(seat.role) ? seat.role : "dev";
}

export function pisoOfZone(zoneId: string): number {
  return FLOORS.find((f) => f.zonas.some((z) => z.id === zoneId))!.piso;
}

function fixedPlace(id: AgentId): Place {
  for (const f of FLOORS) for (const z of f.zonas) { const t = z.fijos?.[id]; if (t) return { piso: f.piso, tile: t }; }
  throw new Error(`sin puesto fijo para ${id}`);
}

export function placeAgents(state: OfficeState, prev: ReadonlyMap<string, Place>): WorldAgent[] {
  const out: WorldAgent[] = [];
  for (const id of FIXED) {
    const a = state.agents.find((x) => x.id === id);
    const p = fixedPlace(id);
    out.push({
      key: id, nombre: ROLES[id].label, rol: null, cuenta: null, color: ROLES[id].color, criatura: id,
      working: a?.working ?? false, paused: a?.paused ?? false, activity: a?.activity ?? "", model: a?.model ?? null,
      tokens: a?.tokens ?? null, planId: null, stepKey: null, progress: null, ...p,
    });
  }
  const seats = state.agents.find((x) => x.id === "agy")?.seats ?? [];
  const taken = new Map<number, Set<string>>(FLOORS.map((f) => [f.piso, new Set(out.filter((o) => o.piso === f.piso).map((o) => key(o.tile)))]));
  // Conserva la casilla previa si sigue dentro de la misma zona (asiento o casilla libre de desborde).
  const keepOf = (k: string, zone: string): Place | null => {
    const p = prev.get(k);
    return p && p.piso === pisoOfZone(zone) && zoneAt(floorOf(p.piso), p.tile)?.id === zone && !isSolid(floorOf(p.piso), ...p.tile) ? p : null;
  };
  const wants = seats.map((s) => { const k = `agy:${s.account}`, zone = zoneForSeat(s); return { s, k, zone, kept: keepOf(k, zone) }; });
  const ordered = [...wants.filter((w) => w.kept), ...wants.filter((w) => !w.kept).sort((a, b) => a.k.localeCompare(b.k))];
  for (const w of ordered) {
    const piso = pisoOfZone(w.zone);
    const map = floorOf(piso);
    const used = taken.get(piso)!;
    const kept = w.kept;
    const tile = (kept && !used.has(key(kept.tile)) ? kept.tile : null)
      ?? zoneSeats(map, w.zone).find((t) => !used.has(key(t)))
      ?? freeTileIn(map, map.zonas.find((z) => z.id === w.zone)!, used)
      ?? map.llegada;
    used.add(key(tile));
    const rol = w.s.working && isRoleZone(w.s.role) ? w.s.role : null;
    out.push({
      key: w.k, nombre: w.s.local ? "tu cuenta" : w.s.account, rol, cuenta: w.s.account,
      color: rol ? roleColor(rol) : ROLES.agy.color, criatura: (rol ?? "agy") as CreatureKind,
      working: w.s.working, paused: false, activity: w.s.activity, model: w.s.model, tokens: null,
      planId: w.s.planId, stepKey: w.s.stepKey, progress: w.s.progress, piso, tile,
    });
  }
  return out;
}

export function planRoute(from: Place, to: Place): Leg[] {
  if (from.piso === to.piso) return [{ piso: from.piso, path: findPath(floorOf(from.piso), from.tile, to.tile) }];
  const a = floorOf(from.piso), b = floorOf(to.piso);
  return [
    { piso: from.piso, path: findPath(a, from.tile, a.elevador) },
    { piso: to.piso, path: [b.llegada, ...findPath(b, b.llegada, to.tile)] },
  ];
}
