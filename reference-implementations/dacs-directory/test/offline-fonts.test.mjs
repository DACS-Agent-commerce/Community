import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('root layout does not require Google font downloads during a production build', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /\bfrom\s*['"]next\/font\/google['"]/, 'Use bundled font assets so production builds do not depend on Google font availability');
});

const fonts = [
  ['PlusJakartaSans', '--font-jakarta', 400, 700],
  ['SourceCodePro', '--font-scp', 400, 600],
];

for (const [family, variable, minimum, maximum] of fonts) {
  test(`${family} bundles a variable TrueType font covering both requested weight boundaries`, () => {
    const font = readFileSync(new URL(`../app/fonts/${family}-variable.ttf`, import.meta.url));
    assert.equal(font.readUInt32BE(0), 0x00010000);
    const tables = font.readUInt16BE(4);
    let variationOffset;
    for (let i = 0; i < tables; i++) {
      const offset = 12 + i * 16;
      if (font.toString('ascii', offset, offset + 4) === 'fvar') variationOffset = font.readUInt32BE(offset + 8);
    }
    assert.notEqual(variationOffset, undefined, 'font must include variable axes');
    const axesOffset = font.readUInt16BE(variationOffset + 4);
    const axisCount = font.readUInt16BE(variationOffset + 8);
    const axisSize = font.readUInt16BE(variationOffset + 10);
    let weightRange;
    for (let i = 0; i < axisCount; i++) {
      const offset = variationOffset + axesOffset + i * axisSize;
      if (font.toString('ascii', offset, offset + 4) === 'wght') {
        weightRange = [font.readInt32BE(offset + 4) / 65536, font.readInt32BE(offset + 12) / 65536];
      }
    }
    assert.ok(weightRange, 'font must expose the weight axis');
    assert.ok(weightRange[0] <= minimum && weightRange[1] >= maximum);
    const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    assert.ok(layout.includes(`src: "./fonts/${family}-variable.ttf"`));
    assert.ok(layout.includes(`variable: "${variable}"`));
    assert.ok(layout.includes(`weight: "${minimum} ${maximum}"`));
    const license = readFileSync(new URL(`../app/fonts/${family}-OFL.txt`, import.meta.url), 'utf8');
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  });
}
