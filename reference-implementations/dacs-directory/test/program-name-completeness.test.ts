import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'dacs-search-page-'));
process.env.DACS_DIRECTORY_DATA = directory;
const { resolveOwnedAnchorByName } = await import('../src/catalog/chain.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));

for (const visibleForeign of [0, 1, 31]) test(`an ACL-filtered page with ${visibleForeign} visible foreign programs cannot establish absence`, async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  // Model pinned node ac8f45f: page first, then ACL filtering. Thirty-two newer
  // foreign entries fill page zero; the older public owner listing is on page
  // one. An empty or short filtered response cannot prove absence.
  const name = 'dacs1-resume';
  const owner = `0x${'12'.repeat(32)}`;
  const rows = [
    ...Array.from({length: 32}, (_, i) => ({storageAddress: `stor-${String(i + 1).padStart(40, '0')}`, programName: name, owner: `0x${'34'.repeat(32)}`, public: i < visibleForeign})),
    {storageAddress: `stor-${'f'.repeat(40)}`, programName: name, owner, public: true},
  ];
  globalThis.fetch = async (input, init) => {
    if (init?.method !== 'POST') {
      const row = rows.find(row => String(input).endsWith(row.storageAddress));
      return row?.public ? Response.json({success:true, owner:row.owner, programName:row.programName, data:{listingId:'service'}})
        : Response.json({success:false,errorCode:'PERMISSION_DENIED'}, {status:403});
    }
    const request = JSON.parse(String(init?.body));
    calls.push(request.method);
    if (request.method === 'nodeCall') return Response.json({result: 200, response: '{ error: "Unknown message"}'});
    assert.equal(request.method, 'gcr_routine');
    const [query, options] = request.params[0].params;
    assert.equal(query, name);
    const response = rows.slice(options.offset, options.offset + options.limit).filter(row => row.public)
      .map(({public: _, ...row}) => row);
    return Response.json({result: 200, response});
  };
  try {
    const result = await resolveOwnedAnchorByName(name, owner);
    assert.equal(result.status, 'indeterminate', 'never authorize a duplicate CREATE from an ACL-filtered page');
    assert.deepEqual(calls, ['nodeCall', 'gcr_routine']);
    assert.equal(rows[32].owner, owner, 'the owned public listing exists beyond the filtered first page');
  } finally { globalThis.fetch = original; }
});
