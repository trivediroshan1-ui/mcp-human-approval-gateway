import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_STATIC_DEMO=true produces a fully self-contained static build for GitHub Pages.
// The Node/SQLite server is not bundled; all API calls are handled by the browser demo service.
const isStaticDemo = process.env.VITE_STATIC_DEMO === "true";

export default defineConfig({
  plugins: [react()],

  // GitHub Pages serves from /mcp-human-approval-gateway/ when using a project page.
  // In demo mode we set the base to the repo name; local server build keeps "/".
  base: isStaticDemo ? "/mcp-human-approval-gateway/" : "/",

  define: {
    // Expose the flag as a compile-time constant so dead-code elimination removes
    // the fetch path in the static build.
    "import.meta.env.VITE_STATIC_DEMO": JSON.stringify(
      isStaticDemo ? "true" : "false",
    ),
  },

  server: {
    port: 5174,
    proxy: isStaticDemo
      ? {}
      : {
          "/api": "http://127.0.0.1:4174",
        },
  },

  build: {
    outDir: isStaticDemo ? "dist/demo" : "dist/client",
    emptyOutDir: true,
  },
});
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_STATIC_DEMO=true produces a fully self-contained static build for GitHub Pages.
// The Node/SQLite server is not bundled; all API calls are handled by the browser demo service.
const isStaticDemo = process.env.VITE_STATIC_DEMO === "true";

export default defineConfig({
  plugins: [react()],

  // GitHub Pages serves from /mcp-human-approval-gateway/ when using a project page.
  // In demo mode we set the base to the repo name; local server build keeps "/".
  base: isStaticDemo ? "/mcp-human-approval-gateway/" : "/",

  define: {
    // Expose the flag as a compile-time constant so dead-code elimination removes
    // the fetch path in the static build.
    "import.meta.env.VITE_STATIC_DEMO": JSON.stringify(
      isStaticDemo ? "true" : "false",
    ),
  },

  server: {
    port: 5174,
    proxy: isStaticDemo
      ? {}
      : {
          "/api": "http://127.0.0.1:4174",
        },
  },

  build: {
    outDir: isStaticDemo ? "dist/demo" : "dist/client",
    emptyOutDir: true,
  },
});
