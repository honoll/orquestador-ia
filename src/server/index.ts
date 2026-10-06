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
import geminiAnalyzeRoute from "./routes/gemini-analyze.js";
import cavemanRoute from "./routes/caveman.js";
import usageRoute from "./routes/usage.js";

// Run migration on startup and wait for it to finish before accepting connections
import { migrationDone } from "../db/migrate.js";
await migrationDone;

const log = pino({ name: "server" });
const PORT = parseInt(process.env.ORQUESTADOR_PORT || "3100", 10);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/api/*", cors({ origin: "*" }));

app.route("/api/adapters", adaptersRoute);
app.route("/api/projects", projectsRoute);
app.route("/api/tasks", tasksRoute);
app.route("/api/runs", runsRoute);
app.route("/api/plans", plansRoute);
app.route("/api/claude-profiles", claudeProfilesRoute);
app.route("/api/shell", shellRoute);
app.route("/api/github", githubRoute);
app.route("/api/gemini", geminiAnalyzeRoute);
app.route("/api/caveman", cavemanRoute);
app.route("/api/usage", usageRoute);

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

const uiDistPath = path.resolve(import.meta.dirname, "../../ui/dist");
if (fs.existsSync(uiDistPath)) {
  app.use("/*", serveStatic({ root: "./ui/dist" }));
  app.get("*", serveStatic({ root: "./ui/dist", path: "index.html" }));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  log.info(`Orquestador-IA running at http://127.0.0.1:${info.port}`);
});

injectWebSocket(server);
