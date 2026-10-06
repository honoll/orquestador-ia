import fs from "node:fs";
import path from "node:path";
import { broadcast } from "./ws.js";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";

const activeWatchers = new Map<string, fs.FSWatcher>();

// Directories/files to always ignore
const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".cache",
  "__pycache__", ".dart_tool", ".flutter", ".pub-cache", ".gradle",
  "ios", "android", // Flutter native dirs that rarely change meaningfully
]);

// Binary/lockfile extensions to skip
const IGNORED_EXT = /\.(png|jpg|jpeg|gif|ico|bmp|webp|svg|ttf|woff|woff2|eot|mp4|mp3|wav|zip|gz|tar|lock|db|sqlite|pyc|class)$/i;

// Debounce map: filePath → timeout id
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 300;

export function startWatch(planId: string, dir: string): void {
  if (activeWatchers.has(planId)) return;

  try {
    const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return;

      // Normalize separators
      const normalizedFilename = filename.replace(/\\/g, "/");

      // Ignore hidden/binary/locked dirs
      const parts = normalizedFilename.split("/");
      if (parts.some((p) => IGNORED_DIRS.has(p) || p.startsWith("."))) return;
      if (IGNORED_EXT.test(normalizedFilename)) return;

      const fullPath = path.join(dir, filename);

      // Debounce rapid saves of the same file
      const debounceKey = `${planId}:${normalizedFilename}`;
      clearTimeout(debounceMap.get(debounceKey));
      debounceMap.set(
        debounceKey,
        setTimeout(() => {
          debounceMap.delete(debounceKey);
          let content = "";
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) return;
            if (stat.size > 200_000) {
              content = "[archivo demasiado grande para previsualizar]";
            } else {
              content = fs.readFileSync(fullPath, "utf8");
            }
          } catch {
            return; // deleted or unreadable
          }

          broadcast({
            type: "file:change",
            planId,
            filePath: normalizedFilename,
            content,
            timestamp: new Date().toISOString(),
          } as any);

          // Persist to DB (upsert by planId+filePath so repeated saves don't duplicate)
          db.insert(schema.planFileChanges)
            .values({
              id: randomUUID(),
              planId,
              filePath: normalizedFilename,
              content,
              changedAt: new Date().toISOString(),
            })
            .onConflictDoUpdate({
              target: [schema.planFileChanges.planId, schema.planFileChanges.filePath],
              set: {
                content,
                changedAt: new Date().toISOString(),
              },
            })
            .catch((err: unknown) => {
              console.error("[file-watcher] DB upsert error:", err);
            });
        }, DEBOUNCE_MS),
      );
    });

    watcher.on("error", (err) => {
      console.error("[file-watcher] watcher error for plan", planId, err);
      stopWatch(planId);
    });

    activeWatchers.set(planId, watcher);
    console.log(`[file-watcher] watching ${dir} for plan ${planId}`);
  } catch (err) {
    console.error("[file-watcher] Failed to start watcher for", dir, err);
  }
}

export function stopWatch(planId: string): void {
  const watcher = activeWatchers.get(planId);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(planId);
    // Clear any pending debounce timeouts for this plan
    for (const [key] of debounceMap) {
      if (key.startsWith(`${planId}:`)) {
        clearTimeout(debounceMap.get(key));
        debounceMap.delete(key);
      }
    }
    console.log(`[file-watcher] stopped watching for plan ${planId}`);
  }
}

export function isWatching(planId: string): boolean {
  return activeWatchers.has(planId);
}
