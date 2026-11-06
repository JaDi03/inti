import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Privy App ID is public (it ships to the browser). It is read from the
// root .env so there is one config file; only PRIVY_APP_ID is exposed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn/ui alias: "@/..." resolves to web/src.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // near-api-js -> is-my-json-valid -> generate-function -> util reads
  // process.env.NODE_DEBUG at load time; browsers have no `process`.
  define: { "process.env": "{}" },
  envDir: "..",
  envPrefix: ["PRIVY_APP_ID"],
  server: { port: 5173, strictPort: true },
});
