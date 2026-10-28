// A separate SQLite connection and builder process; the parent synchronizes nonce reads.
import { NextRequest } from "next/server.js";
import { pathToFileURL } from "node:url";
const [bundle, serialized] = process.argv.slice(2);
const { input, rails, clock, race, crash, synchronize, forbidNonce, nonce = 0 } = JSON.parse(serialized);
const module = await import(pathToFileURL(bundle).href);
Date.now = () => clock;
globalThis.fetch = async (_url, init) => {
  const call = JSON.parse(init.body).params[0];
  if (call.message === "getAddressNonce") {
    if (forbidNonce) throw new Error("a retained retry must not request a nonce");
    if (race) {
      const continued = new Promise((resolve) => process.once("message", resolve));
      process.send({ ready: true });
      await continued;
    }
    return Response.json({ result: 200, response: nonce });
  }
  return Response.json({ result: 200, response: [] });
};
if (synchronize) {
  const continued = new Promise((resolve) => process.once("message", resolve));
  process.send({ ready: true });
  await continued;
}
if (crash) module.openChainReadWindow();
const response = await module.createBuildListingPost(rails)(new NextRequest("https://directory.example/api/dacs/build-listing", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}));
if (crash) process.exit(77); // Durable save, no HTTP response, and no window cleanup.
process.send({ status: response.status, body: await response.json() }, () => process.exit(0));
