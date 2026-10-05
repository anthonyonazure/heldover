import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
export default tseslint.config(
  // Leading **/ matters: "dist/**" only ever matched a dist folder at the repo
  // root, so a nested build output (packages/*/dist, ticker/dist) was linted as
  // if it were source and buried the real findings under hundreds of errors
  // about generated code.
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/*.cjs"] },
  js.configs.recommended,
  // Type-aware rules need type information, which untyped JavaScript does not have, so they apply to TypeScript only.
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: TS_FILES })),
  {
    files: TS_FILES,
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Declare each runtime's globals. Without this, no-undef reports fetch,
  // console and process as undefined, which is a missing environment
  // declaration, not a code defect. No rule is disabled.
  { files: ["server/**/*.{js,mjs}", "client/*.config.js"], languageOptions: { globals: { ...globals.node } } },
  { files: ["client/src/**/*.js"], languageOptions: { globals: { ...globals.browser } } },
  { files: ["electron/main.js"], languageOptions: { sourceType: "commonjs", globals: { ...globals.node } } },
  { files: ["electron/setup.js"], languageOptions: { sourceType: "script", globals: { ...globals.browser } } },
);
