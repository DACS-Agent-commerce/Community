// Emit the two compatibility modules from their patched sources with the pinned
// release Node transformer. This fixes their output bytes independently of tsc's
// source-map positions; tsc still checks and emits the complete SDK first.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve, join } from "node:path";

const sdk = resolve(process.argv[2] ?? "vendor/dacs-sdk");
for (const module of ["artifacts/validators", "agent/verifyBundleCore"]) {
  const source = readFileSync(join(sdk, `src/${module}.ts`), "utf8");
  writeFileSync(join(sdk, `dist/${module}.js`), stripTypeScriptTypes(source, { mode: "transform" }));
  for (const extension of ["js.map", "d.ts.map"]) rmSync(join(sdk, `dist/${module}.${extension}`), { force: true });
  const declaration = join(sdk, `dist/${module}.d.ts`);
  writeFileSync(declaration, readFileSync(declaration, "utf8").replace(/^\/\/# sourceMappingURL=.*\n?/m, ""));
}
