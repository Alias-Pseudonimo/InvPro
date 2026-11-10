import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Optional allowlist for previewing the UI from a remote host. Set
// VITE_PREVIEW_ALLOWED_HOST to the exact hostname; nothing is hardcoded here.
const previewHost = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.VITE_PREVIEW_ALLOWED_HOST;

// Tauri expects a fixed dev port and does not want Vite clearing the console.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: previewHost ? [previewHost] : [],
  },
  build: {
    target: "chrome110",
    sourcemap: false,
    outDir: "dist",
  },
});
