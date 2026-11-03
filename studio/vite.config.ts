import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Studio page is built into dist/studio/ and served by dist/tools/studio.js.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../dist/studio", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
