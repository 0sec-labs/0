import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(rootDir, "../../package.json"), "utf8")) as { version: string };

export default defineConfig({
  define: { __ZERO_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: { host: "127.0.0.1", ...(process.env.ZERO_DEV_FRONTEND_PORT ? { clientPort: Number(process.env.ZERO_DEV_FRONTEND_PORT) } : {}) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: { operations: resolve(rootDir, "index.html") },
      output: {
        // Only eagerly-needed libraries get a named vendor chunk; mermaid/katex/highlight.js/shaders stay
        // on their dynamic-import graph so they never join the entry's static dependencies.
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](?:react|react-dom|scheduler|react-router|react-router-dom)[\\/]/, priority: 40 },
            { name: "vendor-query", test: /node_modules[\\/]@tanstack[\\/]/, priority: 30 },
            { name: "vendor-dockview", test: /node_modules[\\/]dockview/, priority: 30 },
            { name: "vendor-base-ui", test: /node_modules[\\/]@base-ui[\\/]/, priority: 30 },
            { name: "vendor-markdown", test: /node_modules[\\/](?:react-markdown|remark-[\w-]+|micromark[\w-]*|mdast-util-[\w-]+|hast-util-to-jsx-runtime|unified|unist-[\w-]+|vfile[\w-]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities[\w-]*|trim-lines|bail|trough|devlop|estree-util-[\w-]+)[\\/]/, priority: 30 },
            { name: "vendor-icons", test: /node_modules[\\/]lucide-react[\\/]/, priority: 30 },
          ],
        },
      },
    },
  },
});
