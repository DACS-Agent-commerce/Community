#!/usr/bin/env node
// Digest of a built dacs-sdk `dist` tree, so setup can pin the exact bytes the
// pinned commit builds to. Each regular file contributes "<sha256>  <path>\n"
// in byte order of its POSIX relative path; the digest is the sha256 of those
// lines. Setup's own top-level `.dacs-sdk-*` files are excluded, and any other
// entry type (a symlink, for example) is refused.
//
// usage: node scripts/sdk-dist-digest.mjs <dist> [--manifest <file>]
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function distManifest(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const entry = lstatSync(path);
      if (entry.isDirectory()) walk(path, relative);
      else if (entry.isFile()) {
        if (!(prefix === "" && name.startsWith(".dacs-sdk-"))) files.push(relative);
      } else throw new Error(`${relative} is not a regular file or directory`);
    }
  };
  walk(root, "");
  if (files.length === 0) throw new Error(`${root} contains no files`);
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return files.map((file) => `${createHash("sha256").update(readFileSync(join(root, file))).digest("hex")}  ${file}\n`).join("");
}

export const distDigest = (root) => createHash("sha256").update(distManifest(root)).digest("hex");

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [root, flag, out] = process.argv.slice(2);
  if (!root || (flag !== undefined && (flag !== "--manifest" || !out))) {
    console.error("usage: node scripts/sdk-dist-digest.mjs <dist> [--manifest <file>]");
    process.exit(2);
  }
  const manifest = distManifest(root);
  if (out) writeFileSync(out, manifest);
  process.stdout.write(`${createHash("sha256").update(manifest).digest("hex")}\n`);
}
