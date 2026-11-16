import { defineConfig } from "vite";

// Tauri serves the dev server on a fixed port and needs a predictable build dir.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    sourcemap: false,
  },
  // pdf.js ships a worker we load explicitly; keep it out of the optimiser's way
  optimizeDeps: { exclude: ["pdfjs-dist"] },
});
