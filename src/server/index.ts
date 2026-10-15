import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { addClient, removeClient } from "./ws.js";
import adaptersRoute from "./routes/adapters.js";
import projectsRoute from "./routes/projects.js";
import tasksRoute from "./routes/tasks.js";
import runsRoute from "./routes/runs.js";
import plansRoute from "./routes/plans.js";
import claudeProfilesRoute from "./routes/claude-profiles.js";
import shellRoute from "./routes/shell.js";
import githubRoute from "./routes/github.js";
import analyzeRoute from "./routes/analyze.js";
import cavemanRoute from "./routes/caveman.js";
import usageRoute from "./routes/usage.js";
import accountsRoute from "./routes/accounts.js";
import agyWorkersRoute from "./routes/agy-workers.js";
import workersRoute from "./routes/workers.js";
import jevRoute from "./routes/jev.js";
import memoryRoute from "./routes/memory.js";
import officeRoute from "./routes/office.js";
import rolesRoute from "./routes/roles.js";
import { createSpritesRoute, createOfficeSpritesRoute } from "./routes/sprites.js";
import { startOfficeEventTracker } from "./office-state.js";
import voiceRoute from "./routes/voice.js";
import voiceAssistantRoute from "./routes/voice-assistant.js";
import { createSystemRoute } from "./routes/system.js";
import { shutdownAssistant } from "../voice/assistant/session.js";
import { originGuard } from "./origin-guard.js";
import { whisper } from "../voice/whisper.js";
import { getDucker } from "../voice/duck.js";

// Llaves locales (p. ej. TYPESAFE_API_KEY) en .env, que está en .gitignore.
try { process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env")); } catch { /* sin .env */ }

// Run migration on startup and wait for it to finish before accepting connections
import { migrationDone } from "../db/migrate.js";
await migrationDone;

const log = pino({ name: "server" });
const PORT = parseInt(process.env.ORQUESTADOR_PORT || "3110", 10);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/api/*", cors({ origin: "*" }));
// Las peticiones que cambian estado solo desde la UI propia (o sin Origin): ver origin-guard.ts.
app.use("/api/*", originGuard());

app.route("/api/adapters", adaptersRoute);
app.route("/api/projects", projectsRoute);
app.route("/api/tasks", tasksRoute);
app.route("/api/runs", runsRoute);
app.route("/api/plans", plansRoute);
app.route("/api/claude-profiles", claudeProfilesRoute);
app.route("/api/shell", shellRoute);
app.route("/api/github", githubRoute);
app.route("/api/analyze", analyzeRoute);
app.route("/api/caveman", cavemanRoute);
app.route("/api/usage", usageRoute);
app.route("/api/accounts", accountsRoute);
app.route("/api/agy-workers", agyWorkersRoute);
app.route("/api/workers", workersRoute);
app.route("/api/jev", jevRoute);
app.route("/api/memory", memoryRoute);
app.route("/api/office/sprites", createOfficeSpritesRoute());
app.route("/api/office", officeRoute);
app.route("/api/roles", rolesRoute);
app.route("/api/voice/assistant", voiceAssistantRoute);
app.route("/api/voice", voiceRoute);
app.route("/api/system", createSystemRoute({ shutdown }));

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      log.info("WebSocket client connected");
      addClient(ws);
    },
    onClose(_evt, ws) {
      log.info("WebSocket client disconnected");
      removeClient(ws);
    },
  })),
);

// Skins del usuario fuera del repo (OFFICE_SPRITES_DIR); antes del serveStatic de ui/dist.
app.route("/sprites", createSpritesRoute());

const uiDistPath =path.resolve(import.meta.dirname, "../../ui/dist");
if (fs.existsSync(uiDistPath)) {
  app.use("/*", serveStatic({ root: "./ui/dist" }));
  app.get("*", serveStatic({ root: "./ui/dist", path: "index.html" }));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  log.info(`Orquestador-IA running at http://127.0.0.1:${info.port}`);
});

injectWebSocket(server);
startOfficeEventTracker();

// Memoria (Cerebro/Ollama): sin índice al arrancar; solo cuando se pide (useMemory o "reindexar").

// whisper-server (voz, F5) arranca de forma perezosa; se apaga junto con el orquestador.
// Ducking de audio: restaura al arrancar lo que quedó atenuado por un cierre brusco, y al salir.
void getDucker().recover();
function cleanup() {
  shutdownAssistant();
  whisper.stop();
  getDucker().closeHelper();
}
// Mismo apagado para señales y para POST /api/system/shutdown (hoisted: la ruta lo usa arriba).
function shutdown(code: number) {
  cleanup();
  process.exit(code);
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => shutdown(sig === "SIGINT" ? 130 : 143));
}
