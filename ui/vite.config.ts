import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";

// Assets de Silero VAD que se sirven en /vad/ (ruta local, sin CDN).
// Solo lo que se carga en runtime con model "v5" y el ort "wasm" (sin jsep/asyncify/jspi).
const VAD_ASSETS: { file: string; from: () => string; type: string }[] = [
  {
    file: "silero_vad_v5.onnx",
    from: () => path.join(import.meta.dirname, "node_modules/@ricky0123/vad-web/dist"),
    type: "application/octet-stream",
  },
  {
    file: "vad.worklet.bundle.min.js",
    from: () => path.join(import.meta.dirname, "node_modules/@ricky0123/vad-web/dist"),
    type: "text/javascript",
  },
  {
    file: "ort-wasm-simd-threaded.mjs",
    from: () => path.join(import.meta.dirname, "node_modules/onnxruntime-web/dist"),
    type: "text/javascript",
  },
  {
    file: "ort-wasm-simd-threaded.wasm",
    from: () => path.join(import.meta.dirname, "node_modules/onnxruntime-web/dist"),
    type: "application/wasm",
  },
];

function vadAssets(): Plugin {
  return {
    name: "vad-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\/vad\//, "");
        const asset = (req.url ?? "").startsWith("/vad/")
          ? VAD_ASSETS.find((a) => a.file === name)
          : undefined;
        if (!asset) return next();
        res.setHeader("Content-Type", asset.type);
        res.end(readFileSync(path.join(asset.from(), asset.file)));
      });
    },
    generateBundle() {
      for (const a of VAD_ASSETS) {
        this.emitFile({
          type: "asset",
          fileName: `vad/${a.file}`,
          source: readFileSync(path.join(a.from(), a.file)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), vadAssets()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/ws": {
        target: "ws://127.0.0.1:3100",
        ws: true,
      },
    },
  },
});
