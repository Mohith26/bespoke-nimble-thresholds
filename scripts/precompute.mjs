// Precompute the heavy, repeated-split results the app shows next to the live certificate.
// node scripts/precompute.mjs  ->  results/results.json
import { readFileSync, writeFileSync } from "node:fs";
import { certify, evaluate, naiveThreshold, simulate, split } from "../src/thresholds.js";
import { itemsFor } from "../src/data.js";

const data = JSON.parse(readFileSync(new URL("../data/decisions.json", import.meta.url)));
const EPS = [0.01, 0.02, 0.03, 0.05, 0.1];
const DELTA = [0.1, 0.05, 0.01];
const N = [250, 500, 1000, 1500, 2000];
const TRIALS = 200;
const SEED = 20261111; // label-draw seed for the default view
const DEFAULT = { question: "banking_intent", model: "nimble-v4.1-max", eps: 0.03, delta: 0.05, nCal: 1000 };

const out = { generated: "scripts/precompute.mjs", trials: TRIALS, seed: SEED, default: DEFAULT, grid: { EPS, DELTA, N }, questions: {} };
const t0 = Date.now();
for (const q of data.questions) {
  out.questions[q.id] = {};
  for (const model of Object.keys(q.models)) {
    const items = itemsFor(q, model);
    const accuracy = items.reduce((s, it) => s + it.ok, 0) / items.length;
    const sims = {};
    const budget = {};
    for (const delta of DELTA) for (const eps of EPS) for (const nCal of N) {
      const r = simulate(items, { eps, delta, nCal, trials: TRIALS, seed: 7 });
      sims[`${eps}|${delta}|${nCal}`] = {
        certified: round(r.certified), naive: round(r.naive), fixed: round(r.fixed),
      };
    }
    // Live-view certificate on the default label draw, for every setting (lets tests pin the page's numbers).
    const live = {};
    for (const delta of DELTA) for (const eps of EPS) for (const nCal of N) {
      const { cal, test } = split(items, nCal, SEED);
      const c = certify(cal, { eps, delta });
      const naive = naiveThreshold(cal, eps);
      live[`${eps}|${delta}|${nCal}`] = {
        lambda: c.lambda, upper: c.upper,
        heldOut: round(evaluate(test, c.lambda)),
        naive: { lambda: naive, heldOut: round(evaluate(test, naive)) },
        fixed: { lambda: 0.8, heldOut: round(evaluate(test, 0.8)) },
      };
    }
    out.questions[q.id][model] = { n: items.length, accuracy, published_accuracy: q.models[model].published_accuracy, sims, live };
    console.log(q.id, model, "done", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  }
}

// Headline numbers quoted in the README and the email.
const key = `${DEFAULT.eps}|${DEFAULT.delta}|${DEFAULT.nCal}`;
const b41 = out.questions.banking_intent["nimble-v4.1-max"];
const b40 = out.questions.banking_intent["nimble-v4-max"];
out.headline = {
  setting: DEFAULT,
  certified_auto_rate_heldout: b41.live[key].heldOut.coverage,
  certified_error_heldout: b41.live[key].heldOut.error,
  certified_threshold: b41.live[key].lambda,
  certified_violation_rate_over_draws: b41.sims[key].certified.violation,
  naive_violation_rate_over_draws: b41.sims[key].naive.violation,
  fixed_0_8_error_heldout: b41.live[key].fixed.heldOut.error,
  same_labels_v4_max_auto_rate: b40.live[key].heldOut.coverage,
};
writeFileSync(new URL("../results/results.json", import.meta.url), JSON.stringify(out));
console.log(JSON.stringify(out.headline, null, 1));

function round(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) r[k] = typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v;
  return r;
}
