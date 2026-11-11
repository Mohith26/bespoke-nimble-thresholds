import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GRID, binomCdf, binomUpper, certify, evaluate, gridCounts, lgamma, naiveThreshold, permutation, perClass,
  reliability, riskCoverage, rng, simulate, snippet, split, startIndices,
} from "../src/thresholds.js";
import { itemsFor, labelName } from "../src/data.js";

const data = JSON.parse(readFileSync(new URL("../data/decisions.json", import.meta.url)));
const results = JSON.parse(readFileSync(new URL("../results/results.json", import.meta.url)));
const q = (id) => data.questions.find((x) => x.id === id);

// Synthetic items whose top-choice probability is exactly the chance of being right.
function calibratedItems(n, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const s = 1 - 0.5 * Math.pow(r(), 3);
    return { s, ok: r() < s ? 1 : 0 };
  });
}

test("lgamma matches log factorials", () => {
  let lf = 0;
  for (let n = 1; n <= 170; n++) {
    lf += Math.log(n);
    assert.ok(Math.abs(lgamma(n + 1) - lf) < 1e-9 * Math.max(1, lf), `n=${n}`);
  }
});

test("binomCdf agrees with direct summation and edge cases", () => {
  const direct = (k, n, p) => {
    let s = 0, c = 1;
    for (let i = 0; i <= k; i++) { if (i > 0) c = (c * (n - i + 1)) / i; s += c * p ** i * (1 - p) ** (n - i); }
    return s;
  };
  for (const [k, n, p] of [[0, 10, 0.1], [3, 20, 0.2], [7, 40, 0.05], [15, 60, 0.3]]) {
    assert.ok(Math.abs(binomCdf(k, n, p) - direct(k, n, p)) < 1e-12, `${k},${n},${p}`);
  }
  assert.equal(binomCdf(5, 5, 0.3), 1);
  assert.equal(binomCdf(-1, 5, 0.3), 0);
  assert.ok(Math.abs(binomCdf(0, 100, 0.03) - 0.97 ** 100) < 1e-14);
});

test("binomUpper is the exact Clopper-Pearson bound", () => {
  // Zero errors in n: the bound is 1 - alpha^(1/n).
  for (const n of [10, 100, 1000]) assert.ok(Math.abs(binomUpper(0, n, 0.05) - (1 - 0.05 ** (1 / n))) < 1e-9);
  const u = binomUpper(26, 870, 0.0125);
  assert.ok(Math.abs(binomCdf(26, 870, u) - 0.0125) < 1e-6);
  assert.ok(u > 26 / 870);
});

test("grid is strict-to-lax and the starts are spread over it", () => {
  for (let j = 1; j < GRID.length; j++) assert.ok(GRID[j] < GRID[j - 1]);
  assert.ok(GRID[0] > 0.99998 && GRID.at(-1) < 0.12);
  assert.deepEqual(startIndices(55, 4), [0, 14, 28, 41]);
});

test("gridCounts matches a brute-force count", () => {
  const items = calibratedItems(500, 3);
  const { nAcc, nErr } = gridCounts(items);
  GRID.forEach((t, j) => {
    const acc = items.filter((it) => it.s >= t);
    assert.equal(nAcc[j], acc.length);
    assert.equal(nErr[j], acc.filter((it) => !it.ok).length);
  });
});

test("certify returns the lowest rejected threshold and its bound covers the labeled error", () => {
  const items = calibratedItems(2000, 11);
  const c = certify(items, { eps: 0.1, delta: 0.05 });
  assert.ok(c.lambda !== null);
  assert.equal(c.lambda, GRID[c.index]);
  for (let j = c.index + 1; j < GRID.length; j++) assert.equal(c.rejected[j], false);
  assert.ok(c.pValues[c.index] <= c.level);
  assert.ok(c.upper <= 0.1 + 1e-9, "the bound at the certified threshold is within the target");
  assert.ok(c.upper >= c.nErr[c.index] / c.nAcc[c.index]);
});

test("fixed-sequence chains stop at the first failure", () => {
  // Errors only in a middle band: the chain that starts above the band must stop at it.
  const items = [];
  for (let i = 0; i < 400; i++) items.push({ s: 0.99999, ok: 1 });
  for (let i = 0; i < 60; i++) items.push({ s: 0.97, ok: 0 });
  for (let i = 0; i < 2000; i++) items.push({ s: 0.5, ok: 1 });
  const c = certify(items, { eps: 0.05, delta: 0.05, starts: 1 });
  const firstFail = c.pValues.findIndex((p) => p > c.level);
  assert.ok(firstFail > 0);
  assert.ok(c.rejected.slice(firstFail).every((r) => !r), "nothing after the first failure is certified");
});

test("no certificate when the labels cannot support the target", () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ s: 0.95, ok: i % 10 === 0 ? 0 : 1 })); // 10% wrong
  const c = certify(items, { eps: 0.05, delta: 0.05 });
  assert.equal(c.lambda, null);
  assert.equal(evaluate(items, c.lambda).accepted, 0);
});

test("property: on random calibrated data the held-out error exceeds the target in at most delta of draws", () => {
  // 200 independent label draws from a large calibrated population.
  const pop = calibratedItems(20000, 99);
  const r = simulate(pop, { eps: 0.05, delta: 0.1, nCal: 600, trials: 200, seed: 5 });
  assert.ok(r.certified.violation <= 0.1 + 0.05, `violation ${r.certified.violation}`); // delta plus Monte Carlo slack
  assert.ok(r.certified.coverage > 0.2, "and still automates a real share");
  assert.ok(r.naive.violation > r.certified.violation, "tuning without a bound misses more often");
});

test("property: randomized monotonicity of evaluate and riskCoverage", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const items = calibratedItems(300, seed);
    const rc = riskCoverage(items);
    for (let j = 1; j < rc.length; j++) assert.ok(rc[j].coverage >= rc[j - 1].coverage);
    const a = evaluate(items, 0.9), b = evaluate(items, 0.8);
    assert.ok(b.accepted >= a.accepted && b.errors >= a.errors);
  }
});

test("split is a deterministic partition", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ s: i / 100, ok: 1, id: i }));
  const a = split(items, 30, 42), b = split(items, 30, 42);
  assert.deepEqual(a.calIdx, b.calIdx);
  assert.equal(new Set([...a.calIdx, ...a.testIdx]).size, 100);
  assert.deepEqual(permutation(5, 1).slice().sort(), [0, 1, 2, 3, 4]);
  // Growing the label budget only adds labels.
  assert.deepEqual(split(items, 50, 42).calIdx.slice(0, 30), a.calIdx);
});

test("data: joined decisions reproduce Bespoke's published Decision Index accuracies exactly", () => {
  for (const question of data.questions) for (const [model, m] of Object.entries(question.models)) {
    const items = itemsFor(question, model);
    const acc = items.reduce((s, it) => s + it.ok, 0) / items.length;
    assert.ok(Math.abs(acc - m.published_accuracy) < 1e-12, `${question.id} ${model}`);
  }
  assert.equal(q("banking_intent").gold.length, 3080);
  assert.equal(q("assistant_intent").gold.length, 5500);
});

test("headline numbers in results.json are reproduced by the code", () => {
  const h = results.headline;
  const items = itemsFor(q(h.setting.question), h.setting.model);
  const { cal, test } = split(items, h.setting.nCal, results.seed);
  const c = certify(cal, { eps: h.setting.eps, delta: h.setting.delta });
  const held = evaluate(test, c.lambda);
  assert.equal(c.lambda, h.certified_threshold);
  assert.ok(Math.abs(held.coverage - h.certified_auto_rate_heldout) < 1e-6);
  assert.ok(Math.abs(held.error - h.certified_error_heldout) < 1e-6);
  assert.ok(held.error <= h.setting.eps, "the certified threshold met the target on held-out requests");
  const sim = simulate(items, { eps: 0.03, delta: 0.05, nCal: 1000, trials: 200, seed: 7 });
  assert.ok(Math.abs(sim.certified.coverage - results.questions.banking_intent["nimble-v4.1-max"].sims["0.03|0.05|1000"].certified.coverage) < 1e-6);
  assert.ok(sim.certified.violation <= 0.05, "the certificate's miss rate is within delta");
  assert.equal(results.headline.certified_violation_rate_over_draws, sim.certified.violation);
  assert.ok(sim.naive.violation > 0.2, "the uncorrected threshold misses the target in a large share of draws");
  // The docs' example threshold 0.8 overshoots a 3% target on this question.
  assert.ok(evaluate(test, 0.8).error > 0.03);
});

test("helpers: reliability, perClass, naiveThreshold, snippet, labelName", () => {
  const items = itemsFor(q("banking_intent"), "nimble-v4.1-max");
  const rel = reliability(items);
  assert.equal(rel.reduce((s, b) => s + b.n, 0), items.length);
  const pc = perClass(items, 0.9);
  assert.equal(pc.reduce((s, r) => s + r.n, 0), items.length);
  assert.equal(pc.reduce((s, r) => s + r.auto, 0), evaluate(items, 0.9).accepted);
  const nv = naiveThreshold(items, 0.03);
  assert.ok(evaluate(items, nv).error <= 0.03);
  const code = snippet({ question: "banking_intent", model: "nimble-v4.1-max", lambda: 0.94, eps: 0.03, delta: 0.05, nCal: 1000, upper: 0.0291 });
  assert.match(code, /BANKING_INTENT_THRESHOLD = 0\.940000/);
  assert.match(code, /MODEL = "nimble-v4.1-max"/);
  assert.equal(labelName("card_arrival"), "card arrival");
  assert.equal(labelName("oos"), "out of scope");
});
