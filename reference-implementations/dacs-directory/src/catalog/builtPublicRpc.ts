import { createRequire } from "node:module";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { checkTestnetStartup, type TestnetStartupCheck } from "./testnetDeployment.js";

/** Read the public RPC from the compiled manifest, including its build-time settings. */
export async function readBuiltPublicRpc(): Promise<unknown> {
  const { routeModule } = createRequire(import.meta.url)(resolve(".next/server/app/.well-known/dacs-directory.json/route.js"));
  const response = await routeModule.userland.GET(new NextRequest("https://directory.example.org/.well-known/dacs-directory.json"));
  if (response.status !== 200) throw new Error("compiled manifest read failed");
  return (await response.json())?.substrates?.demos?.rpcUrl;
}

/** The scheduled index's testnet gate: the startup check including the compiled manifest's RPC. */
export const checkBuiltTestnetStartup = (): Promise<TestnetStartupCheck> => checkTestnetStartup(readBuiltPublicRpc);
