import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `next build` bundles every "use client" module and everything it imports.
// next.config.mjs swaps four node: builtins for the browser shims in
// src/shims, and webpack fails the build ("Attempted import error") when a
// client-reachable module imports a name the shim does not export. Typecheck
// and the unit tests run on Node's real builtins, so only this walk of the
// client import graph catches that before the production build does.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIMS: Record<string, string> = {
  "node:crypto": "src/shims/node-crypto.ts",
  "node:util": "src/shims/node-util.ts",
  "node:net": "src/shims/node-net.ts",
  "node:url": "src/shims/node-url.ts",
};
// npm packages the browser bundle may load: next.config.mjs maps `buffer` to
// the npm package, and the rest are the app's browser dependencies.
const BROWSER_PACKAGES = ["react", "react-dom", "next", "@noble/ed25519", "@noble/hashes", "buffer"];

interface Fault { file: string; detail: string }

function resolveFile(base: string): string | null {
  const candidates = /\.js$/.test(base)
    // next.config.mjs extensionAlias: ".js" → .js, .ts, .tsx
    ? [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]
    : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js")];
  return candidates.find((file) => existsSync(file) && !readdirSafe(file)) ?? null;
}

function readdirSafe(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The tsconfig paths and relative specifiers the Next build resolves. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return resolveFile(join(ROOT, specifier.slice(2)));
  if (specifier === "@kynesyslabs/dacs") return resolveFile(join(ROOT, "src/sdkVerification"));
  if (specifier.startsWith("@kynesyslabs/dacs/")) {
    return resolveFile(join(ROOT, "vendor/dacs-sdk/dist", specifier.slice("@kynesyslabs/dacs/".length), "index.js"));
  }
  if (specifier.startsWith(".")) return resolveFile(join(dirname(from), specifier));
  return null;
}

interface ModuleImport { specifier: string; names: string[] | "namespace" }

/** Runtime imports only: `import type` / `export type` are erased. */
function moduleImports(file: string): ModuleImport[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const found: ModuleImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        const names: string[] = [];
        let namespace = false;
        if (clause?.name) names.push("default");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespace = true;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
          }
        }
        found.push({ specifier: node.moduleSpecifier.text, names: namespace ? "namespace" : names });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) {
        const clause = node.exportClause;
        const names = clause && ts.isNamedExports(clause)
          ? clause.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
          : "namespace" as const;
        found.push({ specifier: node.moduleSpecifier.text, names });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) found.push({ specifier: argument.text, names: "namespace" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Walk the client import graph from `entries`; return every import webpack's client build refuses. */
function clientBundleFaults(entries: string[], shimExports: Record<string, Set<string>>): { faults: Fault[]; reached: Set<string> } {
  const faults: Fault[] = [];
  const reached = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const where = relative(ROOT, file);
    for (const { specifier, names } of moduleImports(file)) {
      if (specifier.startsWith("node:") || (builtinModules.includes(specifier) && specifier !== "buffer")) {
        const exported = shimExports[specifier];
        if (!exported) {
          faults.push({ file: where, detail: `${specifier} has no browser shim` });
          continue;
        }
        if (names === "namespace") continue;
        for (const name of names) {
          if (!exported.has(name)) faults.push({ file: where, detail: `${specifier} shim does not export ${name}` });
        }
        continue;
      }
      const target = resolveSpecifier(file, specifier);
      if (target) {
        pending.push(target);
      } else if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@kynesyslabs/dacs")) {
        faults.push({ file: where, detail: `${specifier} does not resolve` });
      } else if (!BROWSER_PACKAGES.includes(packageName(specifier))) {
        faults.push({ file: where, detail: `${specifier} is not a browser dependency` });
      }
    }
  }
  return { faults, reached };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function clientEntries(): string[] {
  return [...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "src"))]
    .filter((file) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(readFileSync(file, "utf8")));
}

async function loadShimExports(): Promise<Record<string, Set<string>>> {
  const out: Record<string, Set<string>> = {};
  for (const [builtin, shim] of Object.entries(SHIMS)) {
    out[builtin] = new Set(Object.keys(await import(join(ROOT, shim))));
  }
  return out;
}

test("every node: name a client component reaches is exported by its browser shim", async () => {
  const entries = clientEntries();
  assert.ok(entries.some((file) => file.endsWith("src/components/VerifyDeal.tsx")), "VerifyDeal is a client entry");
  const { faults, reached } = clientBundleFaults(entries, await loadShimExports());
  // The walk does reach the SDK verification code the browser runs.
  for (const file of ["src/catalog/listingVerification.ts", "vendor/dacs-sdk/dist/identity/bundle.js", "vendor/dacs-sdk/dist/crypto/ed25519.js"]) {
    assert.ok(reached.has(join(ROOT, file)), `${file} is client-reachable`);
  }
  assert.deepEqual(faults, []);
});

test("the client walk refuses the SDK identity barrel's Node-only names", async () => {
  // listingVerification.ts once imported identityBundleHash from this barrel,
  // which failed `next build` on exactly these two names.
  const { faults } = clientBundleFaults([join(ROOT, "vendor/dacs-sdk/dist/identity/index.js")], await loadShimExports());
  const details = faults.map((fault) => fault.detail);
  assert.ok(details.includes("node:util shim does not export isDeepStrictEqual"), details.join("\n"));
  assert.ok(details.includes("node:crypto shim does not export randomBytes"), details.join("\n"));
});
