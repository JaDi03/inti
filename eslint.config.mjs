import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "web/public/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
);
