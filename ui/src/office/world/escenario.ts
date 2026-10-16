// Carga del escenario propio (F13): una vez por página. Con escenario → FLOORS + atlas; sin él → pisos de F12.
import { setFloors } from "./maps";
import { toFloorMap, unreachable, type EscenarioPiso } from "./gen3";
import type { Atlas } from "./render";

let cargando: Promise<Map<string, Atlas>> | null = null;

const image = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

async function cargar(): Promise<Map<string, Atlas>> {
  const r = await fetch("/api/office/escenario").catch(() => null);
  const data = r?.ok ? ((await r.json().catch(() => null)) as { pisos?: EscenarioPiso[]; warnings?: string[] } | null) : null;
  for (const w of data?.warnings ?? []) console.warn(`escenario: ${w}`);
  if (!data?.pisos?.length) return new Map();
  const pisos = data.pisos.map((p, i) => toFloorMap(p, i + 1));
  for (const f of pisos) for (const t of unreachable(f)) console.warn(`escenario: piso ${f.piso}, casilla ${t.join(",")} no se alcanza desde el elevador`);
  setFloors(pisos);
  const atlas = new Map<string, Atlas>();
  for (const name of new Set(pisos.map((f) => f.gen3!.atlas))) {
    const [abajo, arriba] = await Promise.all([image(`/escenario/${name}-abajo.png`), image(`/escenario/${name}-arriba.png`)]);
    if (abajo && arriba) atlas.set(name, { abajo, arriba });
    else console.warn(`escenario: no cargó el atlas ${name}; ese piso usa los tiles por código`);
  }
  return atlas;
}

export const loadEscenario = (): Promise<Map<string, Atlas>> => (cargando ??= cargar().catch(() => new Map()));
