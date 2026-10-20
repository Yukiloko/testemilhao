import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  ...tseslint.configs.disableTypeChecked.map((c) => ({ ...c, files: ["**/*.mjs"] })),
  { ignores: [".next/**", "node_modules/**", "drizzle/**", "data/**", "backups/**", "next-env.d.ts"] },
];
