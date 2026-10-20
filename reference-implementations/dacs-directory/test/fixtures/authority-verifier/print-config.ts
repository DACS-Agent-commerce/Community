// Run as its own process: print how this process resolves DACS_AUTHORITY_VERIFIER.
import { loadAuthorityVerifier } from "../../../src/catalog/authorityVerifierConfig.js";

try {
  const config = await loadAuthorityVerifier();
  console.log(JSON.stringify({ id: config.id, optedOut: config.optedOut, verify: typeof config.verify }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
}
