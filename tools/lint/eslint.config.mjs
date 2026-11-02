// Bug-finding rules only. Style is left out on purpose: reformatting would
// touch most files and clash with open PRs.
// How to run it: tools/lint/README.md.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const app = "reference-implementations/dacs-directory";

const bugRules = {
  ...js.configs.recommended.rules,
  // Cleanup rather than bugs, and noisy on this code.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-useless-escape": "off",
  "preserve-caught-error": "off",
  // These regexes strip control characters on purpose.
  "no-control-regex": "off",
  "array-callback-return": "error",
  "no-constructor-return": "error",
  "no-self-compare": "error",
  "no-unreachable-loop": "error",
};

export default [
  {
    // Existing comments may disable rules this config doesn't load, so don't report those.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    // .vendor holds the pinned SDK copy that the setup script fetches.
    ignores: ["**/node_modules/**", "**/.next/**", "**/.vendor/**", "**/vendor/**", "**/test-results/**", "**/playwright-report/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: bugRules,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...bugRules,
      // The TypeScript compiler already reports these, with fewer false alarms.
      "no-undef": "off",
      "no-redeclare": "off",
      "no-dupe-class-members": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // Checks that need type information: a missed `await` is the mistake we
    // most want caught.
    // TypeScript's project settings skip folders starting with a dot.
    files: [`${app}/**/*.{ts,tsx}`],
    ignores: [`${app}/app/.well-known/**`],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parserOptions: {
        project: `${app}/tsconfig.json`,
        tsconfigRootDir: repoRoot,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        // The test runner tracks these itself.
        { allowForKnownSafeCalls: [{ from: "package", name: ["test", "it", "describe", "suite"], package: "node:test" }] },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
