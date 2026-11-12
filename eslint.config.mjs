import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "web/public/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  // Plain Node scripts (server setup, deploy, key generation).
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } } },
);
