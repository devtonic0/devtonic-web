import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run serve` (bridge on :4777) + `npm run dev` (vite on :5173, proxies /api).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 800 },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4777", ws: true } } },
});
