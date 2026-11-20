import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_STORAGE_RESPONSE_BYTES, StorageResponseTooLarge, storageResponseJson, storageArtifactResponseJson } from '../src/catalog/artifactLimits.js';

for (const [name, read] of [['json', storageResponseJson], ['artifact', storageArtifactResponseJson]] as const) {
  test(`${name} refuses oversized bytes even when cancellation never settles`, async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(MAX_STORAGE_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    let timer: ReturnType<typeof setTimeout>;
    const outcome = read(new Response(body)).then(() => 'success', error => error);
    const watchdog = new Promise<string>(resolve => { timer = setTimeout(() => resolve('still pending'), 100); });
    try {
      const result = await Promise.race([outcome, watchdog]);
      assert.equal(cancelled, true);
      assert.ok(result instanceof StorageResponseTooLarge, `expected size refusal, got ${result}`);
    } finally { clearTimeout(timer!); }
  });
}
