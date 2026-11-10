import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The headers the web server sends with every page (web/security-headers.json). The preview
// server sends the same ones, so the page can be tried with them locally.
const securityHeaders = JSON.parse(readFileSync(new URL("./security-headers.json", import.meta.url), "utf8")) as Record<string, string>;

// The Privy App ID and INTI_* values are public (they ship to the browser). They are
// read from the root .env so there is one config file; nothing else is exposed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn/ui alias: "@/..." resolves to web/src.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // near-api-js -> is-my-json-valid -> generate-function -> util reads
  // process.env.NODE_DEBUG at load time; browsers have no `process`.
  define: { "process.env": "{}" },
  envDir: "..",
  envPrefix: ["PRIVY_APP_ID", "INTI_"],
  server: { port: 5173, strictPort: true },
  preview: { headers: securityHeaders },
});
