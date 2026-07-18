// Cardo runs on next 15.x; eslint-config-next 15.x ships the legacy
// eslintrc-style config (not flat). FlatCompat lifts it into the flat
// config we use here.
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const config = [
  {
    // Generated / vendored output — never lint (flat config doesn't read
    // .gitignore). Playwright writes reports + traces here.
    ignores: [
      "test-results/**",
      "playwright-report/**",
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
  ...compat.extends("next/typescript"),
  {
    // Existing-codebase carve-out: these rules accumulate legitimate
    // tech debt across 100+ files but aren't worth blocking CI on a
    // first-pass eslint setup. Tighten to "error" in a follow-up
    // cleanup PR after the in-flight feature work settles.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-css-tags": "warn",
    },
  },
  {
    // Playwright fixtures take a `use()` callback param; the react-hooks
    // plugin mistakes it for React's `use` hook. e2e files aren't React.
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
];

export default config;
