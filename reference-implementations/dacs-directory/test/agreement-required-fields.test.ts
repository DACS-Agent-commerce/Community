import assert from "node:assert/strict";
import test from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { signedScope, verifiedDiscoveryAgreement } from "../src/catalog/evidenceGraph.js";
import { type Obj, dids, locator, vector, payeeBoundVector, installAgreement, graphAt } from "./fixtures/current-evidence.js";

// DACS-3 §8.5: AgreementDocument and PayeeBoundAgreementDocument require terms.deadline, generatedAt,
// and bundleHash plus vetRecordRef on every party. §8.5.3 (FS-1..FS-5): terms.feeSchedule is optional,
// shape-checked disclosure that never gates acceptance.
const PROFILES = [["legacy", vector], ["payee-bound", payeeBoundVector]] as const;
const AGREEMENT_REFERENCE_FAILURE = "agreement reference failed";
const ABSENT = Symbol("absent");

type Mutation = [name: string, apply: (scope: Obj) => void];

const setOrDelete = (target: Obj, key: string, value: unknown) => {
  if (value === ABSENT) delete target[key]; else target[key] = value;
};
const termsOf = (scope: Obj) => scope.terms as Obj;
const partyOf = (scope: Obj, index: number) => (scope.parties as Obj[])[index];

async function graphWithAgreement(make: typeof vector, mutate: (scope: Obj) => void) {
  const fixture = await make();
  const scope = structuredClone(signedScope(fixture.agreement, "agreement"));
  mutate(scope);
  await installAgreement(fixture, scope);
  return { agreement: fixture.agreement, graph: await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing) };
}

async function assertAccepted(profile: string, name: string, make: typeof vector, mutate: (scope: Obj) => void) {
  const { agreement, graph } = await graphWithAgreement(make, mutate);
  assert.equal(graph.ok, true, `${profile}: ${name}: ${graph.reason}`);
  assert.equal(await verifiedDiscoveryAgreement(agreement), true, `${profile}: ${name}: discovery`);
}

async function assertRejected(profile: string, name: string, make: typeof vector, mutate: (scope: Obj) => void) {
  const { agreement, graph } = await graphWithAgreement(make, mutate);
  assert.equal(graph.ok, false, `${profile}: ${name}`);
  assert.equal(graph.reason, AGREEMENT_REFERENCE_FAILURE, `${profile}: ${name}`);
  assert.equal(await verifiedDiscoveryAgreement(agreement), false, `${profile}: ${name}: discovery`);
}

const badTimes = [ABSENT, "80", null, true, {}, [], -1, 1.5];
const badHashes = [ABSENT, 7, null, "", "not-a-hash", "a".repeat(63), "g".repeat(64), {}];
const validRef = () => ({ anchor: { kind: "storage-program", locator: locator(0xf0) }, contentHash: "c".repeat(64) });
const badVetRefs: Array<[string, unknown]> = [
  ["absent", ABSENT], ["null", null], ["string", "stor-ref"], ["array", []], ["empty object", {}],
  ["anchor absent", { contentHash: "c".repeat(64) }],
  ["anchor kind unknown", { ...validRef(), anchor: { kind: "ftp", locator: "x" } }],
  ["anchor kind absent", { ...validRef(), anchor: { locator: "x" } }],
  ["anchor locator empty", { ...validRef(), anchor: { kind: "https", locator: "" } }],
  ["anchor locator not a string", { ...validRef(), anchor: { kind: "https", locator: 7 } }],
  ["content hash absent", { anchor: validRef().anchor }],
  ["content hash malformed", { ...validRef(), contentHash: "xyz" }],
  ["signer not a string", { ...validRef(), signer: 7 }],
];

const requiredFieldMutations: Mutation[] = [
  ...badTimes.map((value): Mutation => [`generatedAt ${String(value)}`, (scope) => setOrDelete(scope, "generatedAt", value)]),
  ...badTimes.map((value): Mutation => [`terms.deadline ${String(value)}`, (scope) => setOrDelete(termsOf(scope), "deadline", value)]),
  ...[0, 1].flatMap((index) => [
    ...badHashes.map((value): Mutation => [`party ${index} bundleHash ${String(value)}`, (scope) => setOrDelete(partyOf(scope, index), "bundleHash", value)]),
    ...badVetRefs.map(([name, value]): Mutation => [`party ${index} vetRecordRef ${name}`, (scope) => setOrDelete(partyOf(scope, index), "vetRecordRef", value)]),
  ]),
];

test("schema-valid agreements of both profiles are accepted", async () => {
  for (const [profile, make] of PROFILES) await assertAccepted(profile, "valid fixture", make, () => undefined);
});

test("agreements missing or mistyping a required field are rejected for each profile", async () => {
  for (const [profile, make] of PROFILES) {
    for (const [name, apply] of requiredFieldMutations) await assertRejected(profile, name, make, apply);
  }
});

test("agreement parties may anchor the Vet reference over ipfs or https", async () => {
  for (const kind of ["ipfs", "https"]) {
    await assertAccepted("legacy", kind, vector, (scope) => {
      partyOf(scope, 0).vetRecordRef = { anchor: { kind, locator: "locator" }, contentHash: "c".repeat(64), signer: dids[2] };
    });
  }
});

const fixedFee = (amount = "0.01") => ({ amount, currency: "DEM" });
const validFeeSchedule = (): Obj => ({
  priceBasis: "exclusive",
  items: [
    { kind: "network", collector: "substrate", fixed: fixedFee(), toleranceBps: 50 },
    { kind: "platform", collector: dids[2], label: "listing fee", rateBps: 25 },
  ],
  oneOffTotal: fixedFee("0.04"),
  disclosureNote: "disclosed before commit",
});
const recurringFeeSchedule = (): Obj => ({
  priceBasis: "inclusive",
  items: [
    { kind: "subscription", collector: dids[1], fixed: fixedFee(), recurrence: { period: "monthly", count: 12 } },
    { kind: "subscription", collector: dids[1], rateBps: 10, recurrence: { period: { everySeconds: 3600 }, until: 5000 } },
  ],
  oneOffTotal: fixedFee("0.02"),
  recurringTotal: fixedFee("0.03"),
  minimumTermSeconds: 86_400,
  earlyTerminationFee: { kind: "other", collector: dids[1], fixed: fixedFee("0.5") },
});

const withFeeSchedule = (value: unknown): Mutation[1] => (scope) => { termsOf(scope).feeSchedule = value; };
const editedSchedule = (edit: (schedule: Obj) => void): Mutation[1] => (scope) => {
  const schedule = validFeeSchedule(); edit(schedule); termsOf(scope).feeSchedule = schedule;
};
const firstItem = (schedule: Obj) => (schedule.items as Obj[])[0];
const platformItem = (schedule: Obj) => (schedule.items as Obj[])[1];

test("agreements without a feeSchedule, or with a well-formed one, are accepted", async () => {
  for (const [profile, make] of PROFILES) {
    await assertAccepted(profile, "no feeSchedule", make, () => undefined);
    await assertAccepted(profile, "fixed and rateBps items", make, withFeeSchedule(validFeeSchedule()));
    await assertAccepted(profile, "recurring disclosure", make, withFeeSchedule(recurringFeeSchedule()));
  }
});

test("a disclosed feeSchedule that does not reconcile never gates acceptance", async () => {
  for (const [profile, make] of PROFILES) {
    await assertAccepted(profile, "totals differ from items and price", make, editedSchedule((schedule) => {
      schedule.oneOffTotal = fixedFee("999");
      firstItem(schedule).toleranceBps = 0;
    }));
  }
});

const malformedFeeSchedules: Mutation[] = [
  ["feeSchedule null", withFeeSchedule(null)],
  ["feeSchedule string", withFeeSchedule("free")],
  ["feeSchedule array", withFeeSchedule([])],
  ["priceBasis absent", editedSchedule((schedule) => delete schedule.priceBasis)],
  ["priceBasis unknown", editedSchedule((schedule) => { schedule.priceBasis = "all-in"; })],
  ["priceBasis not a string", editedSchedule((schedule) => { schedule.priceBasis = 7; })],
  ["items absent", editedSchedule((schedule) => delete schedule.items)],
  ["items not an array", editedSchedule((schedule) => { schedule.items = {}; })],
  ["item not an object", editedSchedule((schedule) => { schedule.items = ["network"]; })],
  ["oneOffTotal absent", editedSchedule((schedule) => delete schedule.oneOffTotal)],
  ["oneOffTotal not an object", editedSchedule((schedule) => { schedule.oneOffTotal = "0.04"; })],
  ["oneOffTotal amount malformed", editedSchedule((schedule) => { schedule.oneOffTotal = fixedFee("abc"); })],
  ["oneOffTotal currency differs from price", editedSchedule((schedule) => { schedule.oneOffTotal = { amount: "0.04", currency: "USD" }; })],
  ["item kind absent", editedSchedule((schedule) => delete firstItem(schedule).kind)],
  ["item kind unknown", editedSchedule((schedule) => { firstItem(schedule).kind = "tax"; })],
  ["item collector absent", editedSchedule((schedule) => delete firstItem(schedule).collector)],
  ["item collector not a string", editedSchedule((schedule) => { firstItem(schedule).collector = 7; })],
  ["item collector empty", editedSchedule((schedule) => { firstItem(schedule).collector = ""; })],
  ["item label not a string", editedSchedule((schedule) => { firstItem(schedule).label = 7; })],
  ["item has neither fixed nor rateBps", editedSchedule((schedule) => delete firstItem(schedule).fixed)],
  ["item has both fixed and rateBps", editedSchedule((schedule) => { firstItem(schedule).rateBps = 10; })],
  ["item fixed malformed", editedSchedule((schedule) => { firstItem(schedule).fixed = { amount: "0.01", currency: 5 }; })],
  ["item rateBps a string", editedSchedule((schedule) => { platformItem(schedule).rateBps = "25"; })],
  ["item rateBps negative", editedSchedule((schedule) => { platformItem(schedule).rateBps = -1; })],
  ["item rateBps null", editedSchedule((schedule) => { platformItem(schedule).rateBps = null; })],
  ["item toleranceBps a string", editedSchedule((schedule) => { firstItem(schedule).toleranceBps = "5"; })],
  ["item toleranceBps negative", editedSchedule((schedule) => { firstItem(schedule).toleranceBps = -1; })],
  ["recurrence a string", editedSchedule((schedule) => { firstItem(schedule).recurrence = "monthly"; })],
  ["recurrence period absent", editedSchedule((schedule) => { firstItem(schedule).recurrence = { count: 2 }; })],
  ["recurrence period unknown", editedSchedule((schedule) => { firstItem(schedule).recurrence = { period: "hourly" }; })],
  ["recurrence everySeconds a string", editedSchedule((schedule) => { firstItem(schedule).recurrence = { period: { everySeconds: "60" } }; })],
  ["recurrence everySeconds zero", editedSchedule((schedule) => { firstItem(schedule).recurrence = { period: { everySeconds: 0 } }; })],
  ["recurrence count a string", editedSchedule((schedule) => { firstItem(schedule).recurrence = { period: "daily", count: "12" }; })],
  ["recurrence until a string", editedSchedule((schedule) => { firstItem(schedule).recurrence = { period: "daily", until: "soon" }; })],
  ["recurringTotal malformed", editedSchedule((schedule) => { schedule.recurringTotal = { amount: "x", currency: "DEM" }; })],
  ["minimumTermSeconds a string", editedSchedule((schedule) => { schedule.minimumTermSeconds = "30"; })],
  ["earlyTerminationFee has neither fixed nor rateBps", editedSchedule((schedule) => { schedule.earlyTerminationFee = { kind: "other", collector: dids[1] }; })],
  ["disclosureNote not a string", editedSchedule((schedule) => { schedule.disclosureNote = 7; })],
];

test("agreements with a malformed feeSchedule are rejected for each profile", async () => {
  for (const [profile, make] of PROFILES) {
    for (const [name, apply] of malformedFeeSchedules) await assertRejected(profile, name, make, apply);
  }
});
