import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Railway's Railpack builder chooses the Node release from package.json engines
// and mise's version files, and Railway doesn't pin which Railpack runs. Rather
// than trust that order, the production build and server check the outcome: they
// fail unless they run the exact .nvmrc release.
export function checkNodeRuntime({ version = process.versions.node, nvmrc = new URL("../.nvmrc", import.meta.url) } = {}) {
  const release = readFileSync(nvmrc, "utf8").trim();
  if (version !== release) {
    throw new Error(`Node ${version} is running, but .nvmrc pins ${release}; set the builder to that release`);
  }
  return `Node runtime matches .nvmrc: ${release}`;
}

// Compare real paths: import.meta.url is resolved, argv[1] may run through a symlink.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    console.log(checkNodeRuntime());
  } catch (error) {
    console.error(`[deployment config] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
