import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.json" },
      },
    },
    rules: {
      // AGENTS.md: "src/core/ no importa nada de src/adapters/". Direccion unica.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./src/adapters",
              message: "src/core/ no puede importar de src/adapters/ (ver AGENTS.md).",
            },
          ],
        },
      ],
    },
  },
  {
    // public/ es JS de navegador servido tal cual (sin build step, ver
    // stack.md#eleccion), no Node: sus globals son otros.
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        location: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
        CSS: "readonly",
        setTimeout: "readonly",
        confirm: "readonly",
        alert: "readonly",
      },
    },
  },
  {
    ignores: ["dist/", "node_modules/", "spike-fase0/"],
  },
);
