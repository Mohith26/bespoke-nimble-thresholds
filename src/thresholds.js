// Certified thresholds for Nimble decisions.
//
// A threshold t turns Nimble's answers into a policy: act on the answer when the
// probability of the top choice is at least t, otherwise hand the request to a person.
// certify() picks the lowest t (so the most automation) for which a finite-sample test on
// the user's labeled examples shows that the error rate among auto-handled requests is at
// most `eps`, with probability at least 1 - delta over the draw of those labels.
//
// Method: Learn then Test (Angelopoulos, Bates, Candes, Jordan, Lei 2021). Each grid
// threshold t_j has the null hypothesis H_j: P(wrong | score >= t_j) > eps. Conditional on
// the number n_j of labeled examples at or above t_j, their error count is
// Binomial(n_j, risk_j), so p_j = P(Binomial(n_j, eps) <= k_j) is a valid p-value. The
// thresholds are tested with fixed-sequence testing from several pre-registered starting
// points (delta split evenly across the starts), which controls the family-wise error
// rate at delta. Every rejected threshold is certified; we return the lowest one.
//
// Pure functions, no dependencies; runs in the browser and in Node.

/** Pre-registered threshold grid: sigmoid(z) for z = 11.5, 11.25, ..., -2.0 (55 points, strict to lax). */
export const GRID = Array.from({ length: 55 }, (_, j) => 1 / (1 + Math.exp(-(11.5 - 0.25 * j))));

/** Starting indices for fixed-sequence testing (evenly spaced over the grid). */
export function startIndices(gridLength, starts) {
  const out = [];
  for (let s = 0; s < starts; s++) out.push(Math.round((s * gridLength) / starts));
  return [...new Set(out)];
}

function logChoose(n, k) {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

// Lanczos approximation, accurate to ~1e-13 for x > 0.
const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LG[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LG[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(Binomial(n, p) <= k), exact (log-space sum). */
export function binomCdf(k, n, p) {
  if (n <= 0 || k >= n) return 1;
  if (k < 0) return 0;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let m = -Infinity;
  const terms = new Array(k + 1);
  for (let i = 0; i <= k; i++) {
    terms[i] = logChoose(n, i) + i * lp + (n - i) * lq;
    if (terms[i] > m) m = terms[i];
  }
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(terms[i] - m);
  return Math.min(1, Math.exp(m + Math.log(s)));
}

/** Exact (Clopper-Pearson) one-sided upper confidence bound on a binomial rate. */
export function binomUpper(k, n, alpha) {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  let lo = k / n, hi = 1;
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

/**
 * Counts of labeled examples accepted and wrongly accepted at each grid threshold.
 * items: array of { s: score, ok: 0|1 }.
 */
export function gridCounts(items, grid = GRID) {
  const sorted = items.slice().sort((a, b) => b.s - a.s);
  const nAcc = new Array(grid.length), nErr = new Array(grid.length);
  let i = 0, acc = 0, err = 0;
  for (let j = 0; j < grid.length; j++) {
    while (i < sorted.length && sorted[i].s >= grid[j]) { acc++; err += 1 - sorted[i].ok; i++; }
    nAcc[j] = acc; nErr[j] = err;
  }
  return { nAcc, nErr };
}

/**
 * Certify a threshold.
 * @returns {{lambda:number|null, index:number, pValues:number[], rejected:boolean[], nAcc:number[], nErr:number[], level:number, upper:number|null}}
 */
export function certify(items, { eps, delta, starts = 4, grid = GRID } = {}) {
  if (!(eps > 0 && eps < 1) || !(delta > 0 && delta < 1)) throw new Error("eps and delta must be in (0, 1)");
  const { nAcc, nErr } = gridCounts(items, grid);
  const pValues = grid.map((_, j) => (nAcc[j] > 0 ? binomCdf(nErr[j], nAcc[j], eps) : 1));
  const st = startIndices(grid.length, starts);
  const level = delta / st.length;
  const rejected = new Array(grid.length).fill(false);
  for (const s of st) {
    for (let j = s; j < grid.length; j++) {
      if (pValues[j] <= level) rejected[j] = true; else break;
    }
  }
  let index = -1;
  for (let j = grid.length - 1; j >= 0; j--) if (rejected[j]) { index = j; break; }
  const lambda = index >= 0 ? grid[index] : null;
  const upper = index >= 0 ? binomUpper(nErr[index], nAcc[index], level) : null;
  return { lambda, index, pValues, rejected, nAcc, nErr, level, upper };
}

/** The obvious approach: the lowest grid threshold whose error on the labeled examples is at most eps. */
export function naiveThreshold(items, eps, grid = GRID) {
  const { nAcc, nErr } = gridCounts(items, grid);
  let best = null;
  for (let j = 0; j < grid.length; j++) if (nAcc[j] > 0 && nErr[j] / nAcc[j] <= eps) best = grid[j];
  return best;
}

/** Share of items auto-handled at threshold t and the error rate among them. t = null means "send everything to a person". */
export function evaluate(items, t) {
  let acc = 0, err = 0;
  if (t !== null && t !== undefined) for (const it of items) if (it.s >= t) { acc++; err += 1 - it.ok; }
  return { n: items.length, accepted: acc, errors: err, coverage: items.length ? acc / items.length : 0, error: acc ? err / acc : 0 };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded permutation of 0..n-1 (Fisher-Yates). */
export function permutation(n, seed) {
  const r = rng(seed), p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}

/** Split items into the first nCal of a seeded permutation (labeled) and the rest (held out). */
export function split(items, nCal, seed) {
  const p = permutation(items.length, seed);
  return { cal: p.slice(0, nCal).map((i) => items[i]), test: p.slice(nCal).map((i) => items[i]), calIdx: p.slice(0, nCal), testIdx: p.slice(nCal) };
}

/**
 * Repeat the whole procedure on many random label draws. The pool of items is the
 * population: a draw "misses" when the chosen threshold's error on the whole pool exceeds
 * eps (that is the quantity the certificate is about). Also reports the mean automation
 * and error on the held-out part of each draw.
 */
export function simulate(items, { eps, delta, nCal, trials = 200, seed = 1, starts = 4, fixed = 0.8 }) {
  const acc = { certified: [], naive: [], fixed: [] };
  const popCache = new Map();
  const popError = (t) => {
    if (!popCache.has(t)) popCache.set(t, evaluate(items, t));
    return popCache.get(t);
  };
  for (let t = 0; t < trials; t++) {
    const { cal, test } = split(items, nCal, seed * 100003 + t);
    const c = certify(cal, { eps, delta, starts });
    for (const [name, th] of [["certified", c.lambda], ["naive", naiveThreshold(cal, eps)], ["fixed", fixed]]) {
      const pop = popError(th);
      acc[name].push({ ...evaluate(test, th), popAccepted: pop.accepted, popError: pop.error });
    }
  }
  const summarize = (rs) => ({
    coverage: rs.reduce((s, r) => s + r.coverage, 0) / rs.length,
    error: rs.reduce((s, r) => s + r.error, 0) / rs.length,
    violation: rs.filter((r) => r.popAccepted > 0 && r.popError > eps).length / rs.length,
    heldOutExceeded: rs.filter((r) => r.accepted > 0 && r.error > eps).length / rs.length,
    none: rs.filter((r) => r.accepted === 0).length / rs.length,
  });
  return { eps, delta, nCal, trials, certified: summarize(acc.certified), naive: summarize(acc.naive), fixed: summarize(acc.fixed) };
}

/** Error among auto-handled items as a function of automation, from strict to lax. */
export function riskCoverage(items, grid = GRID) {
  const { nAcc, nErr } = gridCounts(items, grid);
  return grid.map((t, j) => ({ t, coverage: nAcc[j] / items.length, error: nAcc[j] ? nErr[j] / nAcc[j] : 0, accepted: nAcc[j], errors: nErr[j] }));
}

/** Reliability: within each score band, how often the top choice was right. */
export function reliability(items, edges = [0, 0.5, 0.8, 0.9, 0.95, 0.99, 0.999, 0.9999, 1.0000001]) {
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, right: 0, meanScore: 0 }));
  for (const it of items) {
    const b = bins.find((x) => it.s >= x.lo && it.s < x.hi);
    if (!b) continue;
    b.n++; b.right += it.ok; b.meanScore += it.s;
  }
  return bins.map((b) => ({ ...b, accuracy: b.n ? b.right / b.n : null, meanScore: b.n ? b.meanScore / b.n : null }));
}

/** Per reference label: how many requests, how many auto-handled, and the mistakes among them. */
export function perClass(items, t, labelOf = (it) => it.gold) {
  const m = new Map();
  for (const it of items) {
    const k = labelOf(it);
    if (!m.has(k)) m.set(k, { label: k, n: 0, auto: 0, autoErrors: 0 });
    const r = m.get(k);
    r.n++;
    if (t !== null && it.s >= t) { r.auto++; r.autoErrors += 1 - it.ok; }
  }
  return [...m.values()].map((r) => ({ ...r, autoRate: r.auto / r.n, autoError: r.auto ? r.autoErrors / r.auto : 0 }));
}

/** Python snippet in the style of the Nimble agent skill, with the certified threshold. */
export function snippet({ question, model, lambda, eps, delta, nCal, upper }) {
  const t = lambda === null ? "None  # nothing certified yet: send every request to a person" : lambda.toFixed(6);
  return [
    `MODEL = "${model}"  # pin the model: re-certify when you change it`,
    `# Certified on ${nCal.toLocaleString("en-US")} labeled examples.`,
    `# Error among auto-handled requests <= ${(eps * 100).toFixed(0)}% with probability ${(100 - delta * 100).toFixed(0)}%` + (upper !== null ? ` (bound ${(upper * 100).toFixed(2)}%).` : "."),
    `${question.toUpperCase()}_THRESHOLD = ${t}`,
    ``,
    `answer = response["answers"]["${question}"]`,
    `p = answer["probabilities"][answer["choice"]]`,
    `if ${question.toUpperCase()}_THRESHOLD is not None and p >= ${question.toUpperCase()}_THRESHOLD:`,
    `    route(answer["choice"])`,
    `else:`,
    `    send_to_person(answer)`,
  ].join("\n");
}
