import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deployment = new URL('../deploy/testnet/', import.meta.url);
const read = (name) => readFileSync(new URL(name, deployment), 'utf8');
const service = read('dacs-directory-index.service');
const override = read('index-bootstrap.conf');
const guide = read('DEPLOY-TESTNET.md');

function entries(text) {
  let section = '';
  return text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return [];
    if (line.startsWith('[')) { section = line; return []; }
    const index = line.indexOf('=');
    assert.ok(index > 0, `invalid unit assignment: ${line}`);
    return [[section, line.slice(0, index), line.slice(index + 1)]];
  });
}

test('bootstrap removes the startup deadline without changing the execution or security profile', () => {
  const baseline = entries(service);
  const changes = entries(override);
  assert.deepEqual(changes.map(([section, key]) => [section, key]), [['[Service]', 'TimeoutStartSec']]);
  const effective = new Map(baseline.map(([section, key, value]) => [`${section}/${key}`, value]));
  for (const [section, key, value] of changes) effective.set(`${section}/${key}`, value);
  assert.equal(effective.get('[Service]/TimeoutStartSec'), 'infinity');
  for (const [section, key, value] of baseline) {
    if (key !== 'TimeoutStartSec') assert.equal(effective.get(`${section}/${key}`), value);
  }
  // Removing the drop-in recovers a finite default for routine scheduled passes.
  assert.equal(baseline.find(([section, key]) => section === '[Service]' && key === 'TimeoutStartSec')?.[2], '15min');
});

test('guide installs the supplied override only after stopping scheduling and restores the original timeout', () => {
  const bootstrap = guide.slice(guide.indexOf('## First full scan or long replay'));
  const commands = [...bootstrap.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.equal(commands.length, 2);
  const [start, restore] = commands;
  const destination = '/etc/systemd/system/dacs-directory-index.service.d/90-bootstrap.conf';
  assert.ok(start.indexOf('systemctl stop dacs-directory-index.timer') < start.indexOf('install -m 0644'));
  assert.ok(start.indexOf('systemctl stop dacs-directory-index.service') < start.indexOf('install -m 0644'));
  assert.ok(start.includes(`test ! -e ${destination}`));
  assert.ok(start.includes(`install -m 0644 deploy/testnet/index-bootstrap.conf ${destination}`));
  assert.ok(start.indexOf('systemctl daemon-reload') < start.indexOf('systemctl start --no-block'));
  assert.ok(!start.includes('enable --now'));
  assert.ok(restore.indexOf(`rm ${destination}`) < restore.indexOf('systemctl daemon-reload'));
  assert.ok(restore.indexOf('systemctl daemon-reload') < restore.indexOf('systemctl enable --now dacs-directory-index.timer'));
  assert.ok(bootstrap.includes('exit\nstatus 0 and `catalog written`'));
  assert.ok(bootstrap.includes('Do not restart scheduling after a failed or still-running pass.'));
});
