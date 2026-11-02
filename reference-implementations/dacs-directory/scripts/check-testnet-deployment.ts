/**
 * Startup gate of the testnet deployment (deploy/testnet): exits 1 unless this
 * environment is the testnet profile, both RPCs name the same endpoint and it serves the
 * pinned testnet chain. The systemd units run it before the web server and
 * before every index pass, with --built to also check the compiled manifest.
 *
 *   npm run check:testnet
 */
import { checkTestnetStartup } from "../src/catalog/testnetDeployment.js";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

async function builtPublicRpc(): Promise<unknown> {
  const { routeModule } = createRequire(import.meta.url)(resolve(".next/server/app/.well-known/dacs-directory.json/route.js"));
  const response = await routeModule.userland.GET(new NextRequest("https://directory.example.org/.well-known/dacs-directory.json"));
  if (response.status !== 200) throw new Error("compiled manifest read failed");
  return (await response.json())?.substrates?.demos?.rpcUrl;
}

const result = await checkTestnetStartup(process.argv.includes("--built") ? builtPublicRpc : undefined);
if (!result.ok) {
  console.error(`refusing to start: ${result.reason}`);
  process.exit(1);
}
console.log(`testnet chain ${result.chainIdentity} confirmed`);
