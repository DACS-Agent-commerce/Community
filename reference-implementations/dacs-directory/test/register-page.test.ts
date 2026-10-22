import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import * as React from "react";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (element: React.ReactElement) => string;
};
Object.assign(globalThis, { React });

test("registration documents pointer submission without offering wallet publication", async () => {
  const { default: Register } = await import("../app/register/page.js");
  const html = renderToStaticMarkup(React.createElement(Register));
  assert.match(html, /<h1>Submit listing pointers<\/h1>/);
  assert.match(html, /POST \/api\/dacs\/register/);
  assert.match(html, /href="\/api\/dacs"/);
  assert.match(html, /browser publisher is unavailable/);
  assert.doesNotMatch(html, /<button|<form|Connect wallet|Sign exact artifact/);
});
