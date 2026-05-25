import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devCaseApi } from "./vite.devCaseApi";

/**
 * Vite dev server config. The devCaseApi plugin emulates the Workers API
 * (PRD §6.6) locally so the SPA can do real uploads + engine runs without a
 * deployed Worker. When the Workers dev server is up on :8787, swap the
 * plugin out and re-enable the proxy below.
 */
export default defineConfig({
  plugins: [react(), devCaseApi()],
  server: {
    port: 5173,
    // To use the real Workers dev server instead of the dev middleware:
    // proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
