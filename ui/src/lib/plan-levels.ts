export interface LevelStep {
  stepKey: string | null;
  stepIndex: number;
  dependsOn: string | null;
}

function deps(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Columnas del diagrama: nivel 0 = sin dependencias; los pasos paralelos comparten nivel. */
export function stepLevels<T extends LevelStep>(steps: T[]): T[][] {
  const sorted = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  if (sorted.some((s) => !s.stepKey)) return sorted.map((s) => [s]);
  const byKey = new Map(sorted.map((s) => [s.stepKey!, s]));
  const memo = new Map<string, number>();
  const level = (key: string, seen: Set<string>): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (seen.has(key)) return 0; // ciclo: el backend lo impide; aquí solo no colgarse
    seen.add(key);
    const ds = deps(byKey.get(key)!.dependsOn).filter((d) => byKey.has(d));
    const lv = ds.length ? 1 + Math.max(...ds.map((d) => level(d, seen))) : 0;
    memo.set(key, lv);
    return lv;
  };
  const out: T[][] = [];
  for (const s of sorted) {
    const lv = level(s.stepKey!, new Set());
    (out[lv] ??= []).push(s);
  }
  return out.filter(Boolean);
}
