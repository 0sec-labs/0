import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
    },
  },
  build: {
    outDir: mode === "desktop-alpha" ? resolve(rootDir, "../desktop/dist/dashboard") : "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        operations: resolve(rootDir, "index.html"),
        ...(mode === "desktop-alpha" ? { desktop: resolve(rootDir, "desktop.html") } : {}),
      },
    },
  },
}));
