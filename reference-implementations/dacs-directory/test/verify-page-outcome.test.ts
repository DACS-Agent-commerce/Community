import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React, { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
// The child performs independent signature verification; this test exercises
// the page's artifact-loading interaction and the badge above that child.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/src/components/VerifyDeal") {
      return { url: "data:text/javascript,export default function VerifyDeal() { return null; }", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: VerifyPage } = await import("../app/verify/page.js");
hooks.deregister();

test("loading a completed deal displays a neutral observed outcome badge", async (t) => {
  const address = `stor-${"1".repeat(40)}`;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    assert.equal(String(input), `/api/dacs/artifact?ref=${address}`);
    return Response.json({ value: {
      jobId: "observed-deal", outcome: "completed",
      parties: [{ role: "buyer", primaryClaim: "key:buyer" }],
    } });
  });
  let view: ReactTestRenderer | undefined;
  t.after(async () => { await act(() => view?.unmount()); });
  await act(() => { view = create(React.createElement(VerifyPage)); });
  assert.ok(view);
  const root = view.root;
  await act(() => root.findByProps({ id: "deal-reference" }).props.onChange({ target: { value: address } }));
  const load = root.findByType("button");
  assert.equal(load.props.disabled, false);
  await act(async () => { await load.props.onClick(); });
  assert.deepEqual(requests, [`/api/dacs/artifact?ref=${address}`]);
  const badges = root.findAllByType("span").filter((node) => node.findAllByType("b").some((b) => b.children.join("") === "observed"));
  assert.equal(badges.length, 1, "loaded outcome must remain visible");
  assert.equal(badges[0].props.className, "badge");
  assert.deepEqual(badges[0].children.slice(1), ["completed", "; completion not verified"]);
});
