import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

test("the preparation builder typechecks with the pinned SDK's optional accepted rails", () => {
  const app = fileURLToPath(new URL("..", import.meta.url));
  const builder = fileURLToPath(new URL("../src/catalog/buildListing.ts", import.meta.url));
  const config = ts.readConfigFile(`${app}/tsconfig.json`, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app);
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram([builder], { ...parsed.options, incremental: false });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === builder);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => app, getCanonicalFileName: (path) => path, getNewLine: () => "\n",
  }));
});
