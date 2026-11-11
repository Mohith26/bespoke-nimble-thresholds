import { GRID, binomUpper, certify, evaluate, naiveThreshold, perClass, reliability, snippet, split } from "./src/thresholds.js";
import { itemsFor, labelName } from "./src/data.js";

const STORE_KEY = "nimble-thresholds-v1";
const MODELS = ["nimble-v4.1-max", "nimble-v4-max"];
const EPS = [0.01, 0.02, 0.03, 0.05, 0.1];
const DELTA = [0.1, 0.05, 0.01];
const N = [250, 500, 1000, 1500, 2000];
const PAGE = 25;
const QMETA = {
  banking_intent: {
    title: "Route a banking ticket",
    short: "Which of 77 banking intents does this ticket belong to?",
    unit: "tickets",
    source: "BANKING77 test set: 3,080 customer messages, each labeled with one of 77 intents by people.",
  },
  assistant_intent: {
    title: "Route an assistant request",
    short: "Which of 150 intents fits, or is it out of scope?",
    unit: "requests",
    source: "CLINC150 test set with out-of-scope queries: 5,500 requests labeled by people (1,000 out of scope).",
  },
};

let DATA = null, RESULTS = null;
const cache = new Map();
const app = document.getElementById("app");
const overlay = document.getElementById("overlay");

// ---------- formatting ----------
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
const int = (x) => Math.round(x).toLocaleString("en-US");
const thr = (t) => (t === null || t === undefined ? "None" : t >= 0.9995 ? t.toFixed(6) : t.toFixed(4));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icons = () => window.lucide && window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });

// ---------- state ----------
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.applied) return s;
  } catch (e) { /* fall through */ }
  // First visit: assistant_intent was certified while nimble-v4-max was the latest model.
  return { applied: { assistant_intent: { model: "nimble-v4-max", eps: 0.05, delta: 0.05, n: 1000, appliedAt: "2026-10-20", example: true } } };
}
let store = loadStore();
const saveStore = () => localStorage.setItem(STORE_KEY, JSON.stringify(store));

function parseRoute() {
  const h = location.hash.replace(/^#/, "") || "/thresholds";
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean);
  return { parts, params };
}
function settingsFrom(params, qid) {
  const applied = store.applied[qid];
  const num = (k, list, d) => { const v = Number(params.get(k)); return list.includes(v) ? v : d; };
  return {
    model: MODELS.includes(params.get("model")) ? params.get("model") : (applied && !applied.example ? applied.model : MODELS[0]),
    eps: num("eps", EPS, applied && !applied.example ? applied.eps : 0.03),
    delta: num("delta", DELTA, 0.05),
    n: num("n", N, 1000),
  };
}
function href(qid, s, extra = "", sub = "") {
  const p = new URLSearchParams({ model: s.model, eps: s.eps, delta: s.delta, n: s.n });
  return `#/thresholds/${qid}${sub}?${p}${extra}`;
}

// ---------- computation ----------
function compute(qid, s) {
  const key = `${qid}|${s.model}|${s.eps}|${s.delta}|${s.n}`;
  if (cache.has(key)) return cache.get(key);
  const q = DATA.questions.find((x) => x.id === qid);
  const items = itemsFor(q, s.model);
  const { cal, test } = split(items, s.n, RESULTS.seed);
  const c = certify(cal, { eps: s.eps, delta: s.delta });
  const held = evaluate(test, c.lambda);
  const naive = naiveThreshold(cal, s.eps);
  const out = {
    q, items, cal, test, c, held,
    calEval: evaluate(cal, c.lambda),
    naive: { lambda: naive, held: evaluate(test, naive) },
    fixed: { lambda: 0.8, held: evaluate(test, 0.8) },
    sims: RESULTS.questions[qid][s.model].sims,
    personWrong: test.filter((it) => c.lambda === null || it.s < c.lambda).reduce((a, it) => a + (1 - it.ok), 0),
  };
  cache.set(key, out);
  return out;
}
function statusOf(qid) {
  const a = store.applied[qid];
  if (!a) return { kind: "none" };
  if (a.model !== "nimble-v4.1-max") return { kind: "stale", a };
  return { kind: "ok", a };
}

// ---------- rendering helpers ----------
function crumbs(list) {
  document.getElementById("crumbs").innerHTML = list.map((c, i) => (i < list.length - 1
    ? `<a href="${c.href}">${esc(c.label)}</a><i data-lucide="chevron-right"></i>`
    : `<span class="here" aria-current="page">${esc(c.label)}</span>`)).join("");
}
function setNav(name) {
  document.querySelectorAll(".nav a[data-nav]").forEach((a) => { if (a.dataset.nav === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status");
  t.innerHTML = `<i data-lucide="circle-check"></i>${esc(msg)}`;
  document.body.appendChild(t); icons();
  setTimeout(() => t.remove(), 2600);
}
function statusPill(qid) {
  const st = statusOf(qid);
  if (st.kind === "none") return `<span class="pill pill-muted"><span class="dot"></span>Not applied</span>`;
  if (st.kind === "stale") return `<span class="pill pill-warn"><span class="dot"></span>Re-certify: model changed</span>`;
  return `<span class="pill pill-ok"><span class="dot"></span>Certified</span>`;
}

// ---------- views ----------
function viewList(params) {
  setNav("thresholds");
  crumbs([{ label: "Thresholds" }]);
  const filter = (params.get("q") || "").toLowerCase();
  const rows = DATA.questions.filter((q) => !filter || q.id.includes(filter) || QMETA[q.id].title.toLowerCase().includes(filter) || QMETA[q.id].short.toLowerCase().includes(filter));
  const body = rows.map((q) => {
    const a = store.applied[q.id];
    const s = a ? { model: a.model, eps: a.eps, delta: a.delta, n: a.n } : { model: MODELS[0], eps: 0.03, delta: 0.05, n: 1000 };
    const r = compute(q.id, s);
    return `<tr class="clickable" data-href="${href(q.id, a && a.model === "nimble-v4.1-max" ? s : { ...s, model: MODELS[0] })}">
      <td><a class="row-link" href="${href(q.id, a && a.model === "nimble-v4.1-max" ? s : { ...s, model: MODELS[0] })}"><div class="qname">${q.id}</div></a><div class="qdesc">${esc(QMETA[q.id].short)}</div></td>
      <td style="white-space:nowrap"><span class="mono" style="font-size:12.5px">choice</span><div class="qdesc">${q.options.length} options</div></td>
      <td class="mono" style="font-size:12.5px;white-space:nowrap">${a ? a.model : "nimble-latest"}</td>
      <td class="r num">${int(q.gold.length)}</td>
      <td class="r num">${a ? pct(a.eps, 0) + " at " + (100 - a.delta * 100) + "%" : '<span class="muted">-</span>'}</td>
      <td class="r num mono" style="font-size:12.5px">${a ? thr(r.c.lambda) : '<span class="muted">-</span>'}</td>
      <td class="r num">${a ? pct(r.held.coverage) : '<span class="muted">-</span>'}</td>
      <td>${statusPill(q.id)}</td>
    </tr>`;
  }).join("");
  app.innerHTML = `
    <div class="page-h">
      <div>
        <div class="eyebrow">Nimble · Decision thresholds</div>
        <h1>Thresholds</h1>
        <p>Nimble returns a probability for every answer. A threshold decides which answers your code acts on and which go to a person. Certify it on examples you labeled, so the error rate on the answers you act on stays under a target you choose.</p>
      </div>
      <div class="actions"><a class="btn btn-outline" href="https://docs.bespokelabs.ai/nimble/questions" target="_blank" rel="noopener"><i data-lucide="book-open"></i>How thresholds work</a></div>
    </div>
    ${Object.keys(store.applied).some((k) => statusOf(k).kind === "stale") ? `<div class="alert alert-warning" role="status" style="margin-bottom:16px"><i data-lucide="triangle-alert"></i><div><b>nimble-latest now points to nimble-v4.1-max.</b> A threshold certified on another model does not carry over: probabilities shift between models. Your labels still apply, so re-certifying needs no new labeling.</div></div>` : ""}
    <section class="card" aria-label="Questions">
      <div class="toolbar">
        <div class="input-wrap"><i data-lucide="search"></i><input class="input" id="filter" placeholder="Filter questions" aria-label="Filter questions" value="${esc(params.get("q") || "")}"></div>
        <span class="muted" style="font-size:12.5px">${rows.length + (!filter || "refund_requested".includes(filter) ? 1 : 0)} of ${DATA.questions.length + 1} questions</span>
        <span style="margin-left:auto" class="muted"><span class="kbd">/</span> to search</span>
      </div>
      ${rows.length || !filter || "refund_requested".includes(filter) ? `<table class="table">
        <thead><tr><th>Question</th><th>Type</th><th>Model</th><th class="r">Labeled</th><th class="r">Target error</th><th class="r">Threshold</th><th class="r">Auto-handled</th><th>Status</th></tr></thead>
        <tbody>${body}${!filter || "refund_requested".includes(filter) || "refund".includes(filter) ? `<tr class="clickable" data-href="#/thresholds/refund_requested">
          <td><a class="row-link" href="#/thresholds/refund_requested"><div class="qname">refund_requested</div></a><div class="qdesc">Does the customer ask for a refund?</div></td>
          <td style="white-space:nowrap"><span class="mono" style="font-size:12.5px">noul</span><div class="qdesc">true or false</div></td>
          <td class="mono" style="font-size:12.5px;white-space:nowrap">nimble-latest</td>
          <td class="r num">0</td><td class="r"><span class="muted">-</span></td><td class="r"><span class="muted">-</span></td><td class="r"><span class="muted">-</span></td>
          <td><span class="pill pill-muted"><span class="dot"></span>Needs labels</span></td></tr>` : ""}</tbody></table>`
        : `<div class="empty"><i data-lucide="search-x"></i><h4>No questions match "${esc(filter)}"</h4><div>Questions appear here after you label examples for them.</div></div>`}
    </section>
    <p class="note">Labeled examples here are public, human-labeled benchmark sets standing in for a customer's own labeled tickets. Nimble's probabilities are Bespoke Labs' published Decision Index runs of nimble-v4-max and nimble-v4.1-max.</p>`;
  app.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }));
  const f = document.getElementById("filter");
  f.addEventListener("input", () => {
    const v = f.value;
    history.replaceState(null, "", v ? `#/thresholds?q=${encodeURIComponent(v)}` : "#/thresholds");
    render();
    const g = document.getElementById("filter"); g.focus(); g.setSelectionRange(v.length, v.length);
  });
}

function compareRow(name, sub, t, held, sim, cls = "") {
  return `<tr class="${cls}"><td class="name">${name}<span class="muted">${sub}</span></td>
    <td class="r mono num" style="font-size:12.5px">${thr(t)}</td>
    <td class="r num">${pct(held.coverage)}</td>
    <td class="r num ${held.accepted && held.error > 0 ? "" : ""}">${held.accepted ? pct(held.error, 2) : "-"}</td>
    <td class="r num">${sim ? `<span class="${sim.violation > 0.1 ? "no" : "ok"}" style="font-weight:550">${pct(sim.violation, sim.violation < 0.1 ? 1 : 0)}</span>` : "-"}</td></tr>`;
}

function riskChart(r, s) {
  // Held-out error vs automation along the grid, the labels' upper bound, and the three thresholds.
  const W = 640, H = 300, L = 52, R = 16, T = 16, B = 40;
  const pts = GRID.map((t, j) => {
    const h = evaluate(r.test, t);
    const ub = r.c.nAcc[j] ? binomUpper(r.c.nErr[j], r.c.nAcc[j], r.c.level) : null;
    return { t, j, cov: h.coverage, err: h.error, acc: h.accepted, ub, calCov: r.c.nAcc[j] / r.cal.length };
  }).filter((p) => p.acc > 0);
  const step = s.eps <= 0.02 ? 0.01 : s.eps <= 0.05 ? 0.02 : 0.05;
  const ymax = Math.ceil(Math.max(s.eps * 2, 0.06) / step) * step;
  const x = (v) => L + v * (W - L - R), y = (v) => T + (1 - Math.min(v, ymax) / ymax) * (H - T - B);
  const path = (arr, fx, fy) => arr.map((p, i) => `${i ? "L" : "M"}${fx(p).toFixed(1)},${fy(p).toFixed(1)}`).join("");
  const ub = pts.filter((p) => p.ub !== null && p.calCov > 0);
  const yt = Array.from({ length: Math.round(ymax / step) + 1 }, (_, i) => i * step);
  const mark = (t, color, shape) => {
    if (t === null) return "";
    const h = evaluate(r.test, t);
    if (!h.accepted) return "";
    const cx = x(h.coverage), cy = y(h.error);
    return shape === "sq"
      ? `<rect x="${cx - 4.5}" y="${cy - 4.5}" width="9" height="9" fill="${color}" stroke="hsl(var(--card))" stroke-width="1.5"/>`
      : shape === "tri"
        ? `<path d="M${cx},${cy - 6} L${cx + 5.5},${cy + 4} L${cx - 5.5},${cy + 4} Z" fill="${color}" stroke="hsl(var(--card))" stroke-width="1.5"/>`
        : `<circle cx="${cx}" cy="${cy}" r="6" fill="${color}" stroke="hsl(var(--card))" stroke-width="2"/>`;
  };
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Error among auto-handled requests against the share auto-handled">
    ${yt.map((v) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${pct(v, 0)}</text>`).join("")}
    ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${x(v)}" y="${H - B + 18}" text-anchor="middle">${pct(v, 0)}</text>`).join("")}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Share auto-handled (held out)</text>
    <line x1="${L}" x2="${W - R}" y1="${y(s.eps)}" y2="${y(s.eps)}" stroke="hsl(var(--brand-red-ink))" stroke-width="1.25" stroke-dasharray="5 4"/>
    <text x="${L + 6}" y="${y(s.eps) - 6}" text-anchor="start" style="fill:hsl(var(--brand-red-ink))">Target ${pct(s.eps, 0)}</text>
    <path d="${path(ub, (p) => x(p.calCov), (p) => y(p.ub))}" fill="none" stroke="hsl(var(--brand-blue))" stroke-width="2"/>
    <path d="${path(pts, (p) => x(p.cov), (p) => y(p.err))}" fill="none" stroke="hsl(var(--brand-teal))" stroke-width="2.25"/>
    ${mark(r.fixed.lambda, "hsl(185 9% 52%)", "sq")}
    ${mark(r.naive.lambda, "hsl(185 9% 52%)", "tri")}
    ${mark(r.c.lambda, "hsl(var(--brand-red))", "dot")}
  </svg>
  <div class="legend"><span><i style="border-color:hsl(var(--brand-teal))"></i>Error on held-out ${QMETA[r.q.id].unit}</span><span><i style="border-color:hsl(var(--brand-blue))"></i>Upper bound from your labels</span><span><i style="border-color:hsl(var(--brand-red-ink));border-top-style:dashed"></i>Target</span></div>
  <div class="legend"><span><b class="lg-dot"></b>Certified ${thr(r.c.lambda)}</span><span><b class="lg-tri"></b>Tuned, no bound ${thr(r.naive.lambda)}</span><span><b class="lg-sq"></b>Docs example 0.8</span></div>`;
}

function viewCert(qid, params) {
  setNav("thresholds");
  const s = settingsFrom(params, qid);
  const r = compute(qid, s);
  const meta = QMETA[qid];
  const unit = meta.unit;
  const sk = `${s.eps}|${s.delta}|${s.n}`;
  const sim = r.sims[sk];
  const st = statusOf(qid);
  const a = store.applied[qid];
  const appliedHere = a && a.model === s.model && a.eps === s.eps && a.delta === s.delta && a.n === s.n;
  crumbs([{ label: "Thresholds", href: "#/thresholds" }, { label: qid }]);
  const other = MODELS.find((m) => m !== s.model);
  const ro = compute(qid, { ...s, model: other });
  const pc = perClass(r.test, r.c.lambda).filter((x) => x.autoErrors > 0).sort((x, y) => y.autoErrors - x.autoErrors || y.auto - x.auto).slice(0, 8);
  const rel = reliability(r.test, [0, 0.5, 0.9, 0.99, 0.999, 0.9999, 1.0000001]);
  const code = snippet({ question: qid, model: s.model, lambda: r.c.lambda, eps: s.eps, delta: s.delta, nCal: s.n, upper: r.c.upper });
  const budget = N.map((n) => ({ n, v: r.sims[`${s.eps}|${s.delta}|${n}`].certified.coverage, none: r.sims[`${s.eps}|${s.delta}|${n}`].certified.none }));
  const bmax = Math.max(0.0001, ...budget.map((b) => b.v));

  let banner = "";
  if (st.kind === "stale" && a) {
    banner = `<div class="alert alert-warning" role="status" style="margin-bottom:16px"><i data-lucide="triangle-alert"></i><div><b>The applied threshold was certified on ${a.model}${a.example ? " (example state)" : ""}, applied ${a.appliedAt}.</b> Requests now go to nimble-v4.1-max, whose probabilities differ. Your ${int(a.n)} labels still apply: re-certify on nimble-v4.1-max, review, then apply.</div>
      <div class="actions"><a class="btn btn-outline btn-sm" href="${href(qid, { ...s, model: "nimble-v4.1-max", eps: a.eps, delta: a.delta, n: a.n })}">Re-certify on nimble-v4.1-max</a></div></div>`;
  } else if (appliedHere) {
    banner = `<div class="alert alert-info" role="status" style="margin-bottom:16px"><i data-lucide="circle-check"></i><div><b>Applied ${a.appliedAt}.</b> Requests to <span class="mono">${qid}</span> on ${a.model} use threshold <span class="mono">${thr(r.c.lambda)}</span>; the rest go to a person.</div><div class="actions"><button class="btn btn-ghost btn-sm" id="revert" type="button">Revert</button></div></div>`;
  } else if (a && a.model === "nimble-v4.1-max") {
    const ra = compute(qid, { model: a.model, eps: a.eps, delta: a.delta, n: a.n });
    banner = `<div class="alert alert-info" role="status" style="margin-bottom:16px"><i data-lucide="info"></i><div>Applied now: threshold <span class="mono">${thr(ra.c.lambda)}</span> (${pct(a.eps, 0)} target, ${100 - a.delta * 100}% confidence, ${int(a.n)} labels). You are previewing different settings.</div></div>`;
  }
  const noCert = r.c.lambda === null;

  app.innerHTML = `
    <div class="page-h">
      <div>
        <div class="eyebrow">Choice · ${r.q.options.length} options · <span style="text-transform:none;letter-spacing:.02em">${qid}</span></div>
        <h1>${meta.title}</h1>
        <p>${meta.short} Act on Nimble's answer when its probability clears the threshold; hand the rest to a person.</p>
      </div>
      <div class="actions">
        <div class="rel"><button class="btn btn-outline" id="exportBtn" type="button" aria-haspopup="menu" aria-expanded="false"><i data-lucide="download"></i>Export</button></div>
        <button class="btn btn-primary" id="applyBtn" type="button" ${noCert || appliedHere ? "disabled" : ""} title="Apply (A)"><i data-lucide="${appliedHere ? "check" : "shield-check"}"></i>${appliedHere ? "Applied" : "Apply threshold"}</button>
      </div>
    </div>
    ${banner}
    <section class="card" aria-label="Certificate">
      <form class="controls" id="controls" onsubmit="return false">
        <div class="control"><label for="model">Model</label>
          <select class="select mono" id="model" style="font-size:13px">${MODELS.map((m) => `<option value="${m}" ${m === s.model ? "selected" : ""}>${m}</option>`).join("")}</select></div>
        <div class="control"><span class="lab" id="epsLab">Max error when auto-handled</span>
          <div class="seg" role="group" aria-labelledby="epsLab">${EPS.map((e) => `<button type="button" data-eps="${e}" aria-pressed="${e === s.eps}">${pct(e, 0)}</button>`).join("")}</div></div>
        <div class="control"><span class="lab" id="dLab">Confidence</span>
          <div class="seg" role="group" aria-labelledby="dLab">${DELTA.map((d) => `<button type="button" data-delta="${d}" aria-pressed="${d === s.delta}">${100 - d * 100}%</button>`).join("")}</div></div>
        <div class="control"><label for="nsel">Labeled examples</label>
          <select class="select" id="nsel">${N.map((n) => `<option value="${n}" ${n === s.n ? "selected" : ""}>${int(n)} of ${int(r.items.length)}</option>`).join("")}</select></div>
        <div class="spacer"></div>
        <div class="control"><span class="hint">Held out to check: ${int(r.test.length)} ${unit}</span><span class="hint">Shortcuts: <span class="kbd">[</span> <span class="kbd">]</span> target, <span class="kbd">M</span> model</span></div>
      </form>
      <div class="stats">
        <div class="stat"><div class="k">Certified threshold</div><div class="v mono" style="font-size:${noCert ? 30 : 32}px;font-family:var(--font-mono);letter-spacing:-.03em">${noCert ? "None" : thr(r.c.lambda)}</div>
          <div class="d">${noCert ? `<span class="bad">No threshold meets ${pct(s.eps, 0)}</span> with ${int(s.n)} labels` : `Error bound <b>${pct(r.c.upper, 2)}</b> from ${int(r.calEval.accepted)} labeled ${unit} above it`}</div></div>
        <div class="stat"><div class="k">Auto-handled</div><div class="v">${pct(r.held.coverage)}</div>
          <div class="d"><b>${int(r.held.accepted)}</b> of ${int(r.test.length)} held-out ${unit}</div></div>
        <div class="stat"><div class="k">Error when auto-handled</div><div class="v">${r.held.accepted ? pct(r.held.error, 2) : "-"}</div>
          <div class="d">${r.held.accepted ? `<b>${int(r.held.errors)}</b> wrong · target ${pct(s.eps, 0)} ${r.held.error <= s.eps ? '<span class="pill pill-ok" style="height:19px;margin-left:4px">met</span>' : '<span class="pill pill-bad" style="height:19px;margin-left:4px">missed</span>'}` : "Nothing auto-handled"}</div></div>
        <div class="stat"><div class="k">To a person</div><div class="v">${pct(1 - r.held.coverage)}</div>
          <div class="d"><b>${int(r.test.length - r.held.accepted)}</b> ${unit}; Nimble's answer was wrong on ${int(r.personWrong)}</div></div>
      </div>
    </section>

    <div class="grid2">
      <section class="card" aria-label="Error against automation">
        <div class="card-h"><h3>Error vs. automation</h3><span class="sub">Each point is one threshold on the grid</span></div>
        <div class="card-b">${riskChart(r, s)}</div>
      </section>
      <div class="stack">
        <section class="card compare" aria-label="Ways to set the threshold">
          <div class="card-h"><h3>Three ways to set it</h3></div>
          <div class="card-b" style="padding:10px 0 6px">
            <table class="table"><thead><tr><th>Threshold</th><th class="r">Value</th><th class="r">Auto</th><th class="r">Error</th><th class="r" title="Share of ${RESULTS.trials} random draws of ${int(s.n)} labels where the threshold's error on all ${int(r.items.length)} ${unit} exceeded the target">Missed</th></tr></thead><tbody>
              ${compareRow("Docs example", "0.8, untuned", r.fixed.lambda, r.fixed.held, sim.fixed)}
              ${compareRow("Tuned on labels", "no confidence bound", r.naive.lambda, r.naive.held, sim.naive)}
              ${compareRow("Certified", `${100 - s.delta * 100}% confidence`, r.c.lambda, r.held, sim.certified, "cert")}
            </tbody></table>
            <p class="note" style="padding:0 16px">Auto and Error are on the ${int(r.test.length)} held-out ${unit}. Missed is the share of ${RESULTS.trials} random draws of ${int(s.n)} labels in which the threshold's error on all ${int(r.items.length)} ${unit} exceeded ${pct(s.eps, 0)}; the certificate allows ${pct(s.delta, 0)}.</p>
          </div>
        </section>
        <section class="card" aria-label="Same labels on the other model">
          <div class="card-h"><h3>Same labels, ${other}</h3></div>
          <div class="card-b" style="padding-top:10px">
            <div style="display:flex;gap:28px;align-items:baseline">
              <div><div class="eyebrow" style="font-size:10.5px">${s.model}</div><div class="num" style="font-size:24px;color:hsl(var(--brand-teal))">${pct(r.held.coverage)}</div></div>
              <div><div class="eyebrow" style="font-size:10.5px">${other}</div><div class="num" style="font-size:24px;color:hsl(var(--brand-teal) / .7)">${pct(ro.held.coverage)}</div></div>
              <a class="btn btn-ghost btn-sm" style="margin-left:auto" href="${href(qid, { ...s, model: other })}">Open<i data-lucide="arrow-right"></i></a>
            </div>
            <p class="note">Auto-handled at the same ${pct(s.eps, 0)} target with the same ${int(s.n)} labels; ${other} ${ro.c.lambda === null ? "certifies nothing at this target" : `certifies at <span class="mono">${thr(ro.c.lambda)}</span>`}. Labels carry over between models; thresholds do not.</p>
          </div>
        </section>
      </div>
    </div>

    <div class="grid2">
      <section class="card" aria-label="Labels needed">
        <div class="card-h"><h3>How many labels you need</h3><span class="sub">Average auto-handled over ${RESULTS.trials} label draws</span></div>
        <div class="card-b bars">
          ${budget.map((b) => `<button class="row ${b.n === s.n ? "sel" : ""}" type="button" data-n="${b.n}" aria-label="${int(b.n)} labels: ${pct(b.v)} auto-handled on average">
            <span class="lab">${int(b.n)}</span><span class="track"><span class="fill" style="width:calc((100% - 64px) * ${(b.v / bmax).toFixed(4)})"></span><span class="val">${pct(b.v)}</span></span></button>`).join("")}
          <p class="note">${budget[0].none > 0.5 ? `With ${int(budget[0].n)} labels, ${pct(budget[0].none, 0)} of draws certify nothing at ${pct(s.eps, 0)}. ` : ""}More labels tighten the bound, so the threshold can come down. Click a bar to use that many labels.</p>
        </div>
      </section>
      <section class="card" aria-label="What a probability means">
        <div class="card-h"><h3>What a probability means here</h3></div>
        <div class="card-b" style="padding:10px 0 6px">
          <table class="table rel-table"><thead><tr><th>Nimble's probability</th><th class="r">${unit[0].toUpperCase() + unit.slice(1)}</th><th class="r">Average</th><th>Top choice right</th></tr></thead><tbody>
          ${rel.filter((b) => b.n).reverse().map((b) => `<tr><td class="mono num" style="font-size:12.5px">${b.hi > 1 ? "≥ " + b.lo : b.lo + " to " + b.hi}</td><td class="r num">${int(b.n)}</td><td class="r mono num" style="font-size:12.5px">${pct(b.meanScore)}</td><td class="num"><span class="minibar ${b.accuracy < b.meanScore - 0.02 ? "red" : ""}"><span style="width:${(b.accuracy * 100).toFixed(1)}%"></span></span>${pct(b.accuracy)}</td></tr>`).join("")}
          </tbody></table>
          <p class="note" style="padding:0 16px">Held-out ${unit}. Red bars mark bands where Nimble is right more than 2 points less often than its average probability says.</p>
        </div>
      </section>
    </div>

    <section class="card" style="margin-top:20px" aria-label="Mistakes above the threshold">
      <div class="card-h"><h3>Where the auto-handled mistakes are</h3><span class="sub">Held-out ${unit} above the threshold that Nimble got wrong, by reference label</span>
        <span class="right"><a class="btn btn-outline btn-sm" href="${href(qid, s, "&filter=wrong", "/examples")}">Review all ${unit}<i data-lucide="arrow-right"></i></a></span></div>
      <div class="card-b" style="padding:10px 0 4px">
        ${pc.length ? `<table class="table"><thead><tr><th>Reference label</th><th class="r">Held out</th><th class="r">Auto-handled</th><th class="r">Wrong when auto</th><th></th></tr></thead><tbody>
        ${pc.map((x) => `<tr><td class="mono" style="font-size:12.5px">${esc(labelName(r.q.options[x.label]))}</td><td class="r num">${x.n}</td><td class="r num">${pct(x.autoRate, 0)}</td><td class="r num"><span class="no" style="font-weight:550">${x.autoErrors}</span> <span class="muted">(${pct(x.autoError, 0)})</span></td>
          <td class="r"><a class="btn btn-ghost btn-sm" href="${href(qid, s, `&filter=wrong&label=${x.label}`, "/examples")}" aria-label="View mistakes for ${esc(labelName(r.q.options[x.label]))}">View<i data-lucide="chevron-right"></i></a></td></tr>`).join("")}
        </tbody></table>` : `<div class="empty"><i data-lucide="${noCert ? "shield-off" : "party-popper"}"></i><h4>${noCert ? "Nothing is auto-handled" : "No mistakes above the threshold"}</h4><div>${noCert ? "With no certified threshold, every request goes to a person." : "Every held-out request above the threshold was routed correctly."}</div></div>`}
      </div>
    </section>

    <section class="card" style="margin-top:20px" aria-label="Use it in code">
      <div class="card-h"><h3>Use it in code</h3><span class="sub">Same shape as the Nimble agent skill's example</span><span class="right"><button class="btn btn-outline btn-sm" id="copyBtn" type="button"><i data-lucide="copy"></i>Copy</button></span></div>
      <div class="card-b"><pre class="codeblock" id="code">${highlight(code)}</pre>
      <p class="note">How it is certified: each grid threshold is a hypothesis "error above ${pct(s.eps, 0)}", tested with an exact binomial test on your labels; four fixed-sequence chains split the ${pct(s.delta, 0)} error budget (Learn then Test). The lowest threshold that passes is returned. ${esc(meta.source)}</p></div>
    </section>`;

  // ---- events ----
  const go = (patch) => { location.hash = href(qid, { ...s, ...patch }); };
  document.getElementById("model").addEventListener("change", (e) => go({ model: e.target.value }));
  document.getElementById("nsel").addEventListener("change", (e) => go({ n: Number(e.target.value) }));
  app.querySelectorAll("[data-eps]").forEach((b) => b.addEventListener("click", () => go({ eps: Number(b.dataset.eps) })));
  app.querySelectorAll("[data-delta]").forEach((b) => b.addEventListener("click", () => go({ delta: Number(b.dataset.delta) })));
  app.querySelectorAll(".bars [data-n]").forEach((b) => b.addEventListener("click", () => go({ n: Number(b.dataset.n) })));
  document.getElementById("applyBtn").addEventListener("click", () => confirmApply(qid, s, r));
  document.getElementById("exportBtn").addEventListener("click", (e) => exportMenu(e.currentTarget, qid, s, r));
  document.getElementById("copyBtn").addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(code); toast("Copied the snippet"); });
  const rv = document.getElementById("revert");
  if (rv) rv.addEventListener("click", () => { delete store.applied[qid]; saveStore(); toast("Reverted: every request goes to a person until you apply a threshold"); render(); });
  keyHandlers.cert = { qid, s, r };
}

function highlight(code) {
  return code.split("\n").map((line) => {
    const e = esc(line);
    if (line.startsWith("#")) return `<span class="c">${e}</span>`;
    return e.replace(/(&quot;[^&]*?&quot;)/g, '<span class="s">$1</span>').replace(/\b(if|else|is|not|and|None)\b/g, '<span class="k">$1</span>').replace(/(#.*)$/, '<span class="c">$1</span>');
  }).join("\n");
}

function viewExamples(qid, params) {
  setNav("thresholds");
  const s = settingsFrom(params, qid);
  const r = compute(qid, s);
  const unit = QMETA[qid].unit;
  const filter = ["wrong", "person", "all"].includes(params.get("filter")) ? params.get("filter") : "wrong";
  const label = params.has("label") ? Number(params.get("label")) : null;
  const search = (params.get("q") || "").toLowerCase();
  const page = Math.max(1, Number(params.get("page")) || 1);
  crumbs([{ label: "Thresholds", href: "#/thresholds" }, { label: qid, href: href(qid, s) }, { label: "Held-out " + unit }]);
  const t = r.c.lambda;
  const isAuto = (it) => t !== null && it.s >= t;
  const groups = {
    wrong: r.test.filter((it) => isAuto(it) && !it.ok),
    person: r.test.filter((it) => !isAuto(it)),
    all: r.test,
  };
  let rows = groups[filter];
  if (label !== null) rows = rows.filter((it) => it.gold === label);
  if (search) rows = rows.filter((it) => r.q.text[it.i].toLowerCase().includes(search));
  rows = rows.slice().sort((a, b) => (filter === "person" ? b.s - a.s : b.s - a.s));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const pg = Math.min(page, pages);
  const shown = rows.slice((pg - 1) * PAGE, pg * PAGE);
  const link = (patch) => {
    const p = new URLSearchParams({ model: s.model, eps: s.eps, delta: s.delta, n: s.n, filter, ...(label !== null ? { label } : {}), ...(search ? { q: search } : {}), ...patch });
    for (const [k, v] of [...p.entries()]) if (v === "" || v === "null") p.delete(k);
    return `#/thresholds/${qid}/examples?${p}`;
  };
  const tab = (key, name) => `<button role="tab" aria-selected="${filter === key}" data-go="${link({ filter: key, page: 1 })}">${name}<span class="count">${int((label !== null ? groups[key].filter((it) => it.gold === label) : groups[key]).length)}</span></button>`;
  app.innerHTML = `
    <div class="page-h">
      <div>
        <div class="eyebrow">${qid} · ${s.model} · threshold ${thr(t)}</div>
        <h1>Held-out ${unit}</h1>
        <p>The ${int(r.test.length)} ${unit} not used to certify. Check what an auto-handled mistake looks like and what goes to a person before you apply the threshold. Some reference labels are debatable, so a few "mistakes" may be Nimble being right.</p>
      </div>
      <div class="actions"><a class="btn btn-outline" href="${href(qid, s)}"><i data-lucide="arrow-left"></i>Back to certificate</a><button class="btn btn-outline" id="csvBtn" type="button"><i data-lucide="file-down"></i>Export CSV</button></div>
    </div>
    <section class="card">
      <div class="tabs" role="tablist" aria-label="Filter">${tab("wrong", "Auto-handled, wrong")}${tab("person", "Sent to a person")}${tab("all", "All held out")}</div>
      <div class="toolbar">
        <div class="input-wrap"><i data-lucide="search"></i><input class="input" id="exSearch" placeholder="Search text" aria-label="Search ${unit}" value="${esc(params.get("q") || "")}"></div>
        ${label !== null ? `<span class="pill pill-ok" style="height:26px">Label: ${esc(labelName(r.q.options[label]))}<a href="${link({ label: "", page: 1 })}" aria-label="Clear label filter" style="display:inline-flex"><i data-lucide="x" style="width:13px;height:13px"></i></a></span>` : ""}
        <span class="muted" style="margin-left:auto;font-size:12.5px">${int(rows.length)} ${unit}</span>
      </div>
      ${shown.length ? `<table class="table"><thead><tr><th>${unit[0].toUpperCase() + unit.slice(1, -1)}</th><th>Nimble's answer</th><th class="r">Probability</th><th>Reference</th><th>Outcome</th></tr></thead><tbody>
        ${shown.map((it) => {
          const auto = isAuto(it);
          return `<tr><td class="ex-text">${esc(r.q.text[it.i])}<div class="qdesc mono" style="font-size:11px">${esc(r.q.ids[it.i])}</div></td>
          <td class="mono" style="font-size:12.5px"><span class="${it.ok ? "ok" : "no"}">${esc(labelName(r.q.options[it.choice]))}</span><div class="qdesc">runner-up: ${esc(labelName(r.q.options[it.choice2]))} ${it.p2 < 0.001 ? "<0.001" : it.p2.toFixed(3)}</div></td>
          <td class="r mono num" style="font-size:12.5px">${it.s >= 0.9995 ? it.s.toFixed(6) : it.s.toFixed(4)}</td>
          <td class="mono" style="font-size:12.5px">${esc(labelName(r.q.options[it.gold]))}</td>
          <td>${auto ? (it.ok ? '<span class="pill pill-ok"><span class="dot"></span>Auto, right</span>' : '<span class="pill pill-bad"><span class="dot"></span>Auto, wrong</span>') : `<span class="pill pill-muted"><span class="dot"></span>Person${it.ok ? "" : ", Nimble wrong"}</span>`}</td></tr>`;
        }).join("")}</tbody></table>
        <div class="pager"><span>Page ${pg} of ${pages}</span><span class="btns"><a class="btn btn-outline btn-sm" ${pg <= 1 ? 'aria-disabled="true" style="pointer-events:none;opacity:.5"' : ""} href="${link({ page: pg - 1 })}">Previous</a><a class="btn btn-outline btn-sm" ${pg >= pages ? 'aria-disabled="true" style="pointer-events:none;opacity:.5"' : ""} href="${link({ page: pg + 1 })}">Next</a></span></div>`
        : `<div class="empty"><i data-lucide="inbox"></i><h4>Nothing here</h4><div>${filter === "wrong" ? (t === null ? "No threshold is certified, so nothing is auto-handled." : "No held-out request above the threshold was routed wrong.") : "No requests match."}</div></div>`}
    </section>`;
  app.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { location.hash = b.dataset.go; }));
  const inp = document.getElementById("exSearch");
  let tm;
  inp.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => { history.replaceState(null, "", link({ q: inp.value, page: 1 })); render(); const g = document.getElementById("exSearch"); g.focus(); g.setSelectionRange(g.value.length, g.value.length); }, 150); });
  document.getElementById("csvBtn").addEventListener("click", () => downloadCSV(qid, s, r));
}

function viewNeedsLabels() {
  setNav("thresholds");
  crumbs([{ label: "Thresholds", href: "#/thresholds" }, { label: "refund_requested" }]);
  app.innerHTML = `<div class="page-h"><div><div class="eyebrow">Noul · true or false · <span style="text-transform:none;letter-spacing:.02em">refund_requested</span></div><h1>Does the customer ask for a refund?</h1>
    <p>No labeled examples yet. Every request to this question goes to a person until a threshold is certified.</p></div></div>
    <section class="card"><div class="empty"><i data-lucide="tags"></i><h4>Label examples to certify a threshold</h4>
      <div style="max-width:52ch;margin:0 auto">Upload a CSV of requests with the right answer (<span class="mono">state,label</span>). Nimble scores them; the certificate needs roughly 500 to 1,000 labels for a 3% target, judging by the two routing questions.</div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:center"><button class="btn btn-primary" type="button" disabled title="Uploads are not part of this demo"><i data-lucide="upload"></i>Upload labeled CSV</button><a class="btn btn-outline" href="#/thresholds/banking_intent">See a certified question</a></div></div></section>`;
}

function viewOther(name) {
  setNav(name);
  const labels = { playground: "Playground", keys: "API keys", usage: "Usage", billing: "Billing", settings: "Settings" };
  crumbs([{ label: labels[name] || "Not found" }]);
  app.innerHTML = `<div class="page-h"><div><div class="eyebrow">Nimble console</div><h1>${labels[name] || "Something's missing"}</h1><p>This page is part of the real Nimble console and is not reproduced in this concept demo.</p></div></div>
    <section class="card"><div class="empty"><i data-lucide="sliders-horizontal"></i><h4>The demo covers Thresholds</h4><div><a class="btn btn-primary" href="#/thresholds" style="margin-top:12px">Go to Thresholds</a></div></div></section>`;
}

// ---------- actions ----------
function confirmApply(qid, s, r) {
  overlay.innerHTML = `<div class="dialog-backdrop" id="bd"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgT">
    <h2 id="dlgT">Apply this threshold?</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13.5px">Requests to <span class="mono">${qid}</span> on ${s.model} with a top-choice probability at or above the threshold are handled automatically. The rest go to a person.</p>
    <div class="row"><span>Threshold</span><span class="mono">${thr(r.c.lambda)}</span></div>
    <div class="row"><span>Target error when auto-handled</span><span>${pct(s.eps, 0)} at ${100 - s.delta * 100}% confidence</span></div>
    <div class="row"><span>Labeled examples</span><span class="num">${int(s.n)}</span></div>
    <div class="row"><span>Held-out check</span><span class="num">${pct(r.held.coverage)} auto, ${pct(r.held.error, 2)} wrong</span></div>
    <div class="foot"><button class="btn btn-outline" id="cancel" type="button">Cancel</button><button class="btn btn-primary" id="ok" type="button">Apply</button></div></div></div>`;
  const close = () => { overlay.innerHTML = ""; };
  document.getElementById("cancel").onclick = close;
  document.getElementById("bd").onclick = (e) => { if (e.target.id === "bd") close(); };
  document.getElementById("ok").onclick = () => {
    store.applied[qid] = { model: s.model, eps: s.eps, delta: s.delta, n: s.n, lambda: r.c.lambda, upper: r.c.upper, appliedAt: new Date().toISOString().slice(0, 10) };
    saveStore(); close(); toast(`Applied ${thr(r.c.lambda)} to ${qid}`); render();
  };
  document.getElementById("ok").focus();
}
function exportMenu(btn, qid, s, r) {
  const existing = document.getElementById("menu");
  if (existing) { existing.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  const m = document.createElement("div");
  m.className = "menu"; m.id = "menu"; m.setAttribute("role", "menu");
  m.innerHTML = `<button role="menuitem" type="button" data-x="json"><i data-lucide="file-json"></i>Certificate (JSON)</button><button role="menuitem" type="button" data-x="csv"><i data-lucide="file-spreadsheet"></i>Held-out decisions (CSV)</button>`;
  btn.parentElement.appendChild(m); btn.setAttribute("aria-expanded", "true"); icons();
  m.querySelector('[data-x="json"]').onclick = () => { downloadJSON(qid, s, r); m.remove(); };
  m.querySelector('[data-x="csv"]').onclick = () => { downloadCSV(qid, s, r); m.remove(); };
  m.querySelector("button").focus();
}
function certificate(qid, s, r) {
  return {
    question: qid, model: s.model, threshold: r.c.lambda, target_error: s.eps, confidence: 1 - s.delta,
    labeled_examples: s.n, label_seed: RESULTS.seed,
    labeled_above_threshold: r.calEval.accepted, labeled_errors_above_threshold: r.calEval.errors, error_upper_bound: r.c.upper,
    method: { name: "Learn then Test, fixed-sequence with 4 starts", grid: "sigmoid(z), z = 11.5 to -2.0 step 0.25", p_value: "exact binomial P(Bin(n_acc, eps) <= errors)", per_chain_level: r.c.level },
    held_out: { requests: r.test.length, auto_handled: r.held.accepted, auto_rate: r.held.coverage, errors: r.held.errors, error_rate: r.held.error },
    repeated_draws: { trials: RESULTS.trials, ...r.sims[`${s.eps}|${s.delta}|${s.n}`] },
    data: DATA.meta,
  };
}
function save(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function downloadJSON(qid, s, r) { save(`${qid}-${s.model}-certificate.json`, JSON.stringify(certificate(qid, s, r), null, 2), "application/json"); toast("Exported the certificate"); }
function downloadCSV(qid, s, r) {
  const q = r.q, t = r.c.lambda;
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["id,text,nimble_choice,probability,reference,decision,correct"];
  for (const it of r.test) lines.push([q.ids[it.i], q.text[it.i], q.options[it.choice], it.s, q.options[it.gold], t !== null && it.s >= t ? "auto" : "person", it.ok].map(cell).join(","));
  save(`${qid}-${s.model}-held-out.csv`, lines.join("\n"), "text/csv");
  toast(`Exported ${int(r.test.length)} held-out decisions`);
}
function shortcuts() {
  overlay.innerHTML = `<div class="dialog-backdrop" id="bd"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="kT"><h2 id="kT">Keyboard shortcuts</h2>
    ${[["/", "Search"], ["A", "Apply threshold"], ["E", "Export certificate"], ["[ ]", "Lower or raise the target error"], ["M", "Switch model"], ["T", "Go to Thresholds"], ["Esc", "Close"]].map(([k, v]) => `<div class="row"><span>${v}</span><span class="kbd">${k}</span></div>`).join("")}
    <div class="foot"><button class="btn btn-primary" id="ok" type="button">Done</button></div></div></div>`;
  document.getElementById("ok").onclick = () => { overlay.innerHTML = ""; };
  document.getElementById("bd").onclick = (e) => { if (e.target.id === "bd") overlay.innerHTML = ""; };
  document.getElementById("ok").focus();
}

const keyHandlers = { cert: null };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { overlay.innerHTML = ""; const m = document.getElementById("menu"); if (m) m.remove(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  const { parts } = parseRoute();
  const onCert = parts[0] === "thresholds" && parts[1] && !parts[2];
  if (e.key === "/") { const f = document.getElementById("filter") || document.getElementById("exSearch"); if (f) { e.preventDefault(); f.focus(); } }
  else if (e.key === "?") shortcuts();
  else if (e.key === "t" || e.key === "T") location.hash = "#/thresholds";
  else if (onCert && keyHandlers.cert) {
    const { qid, s, r } = keyHandlers.cert;
    if (e.key === "a" || e.key === "A") { const b = document.getElementById("applyBtn"); if (b && !b.disabled) b.click(); }
    else if (e.key === "e" || e.key === "E") downloadJSON(qid, s, r);
    else if (e.key === "m" || e.key === "M") location.hash = href(qid, { ...s, model: MODELS.find((m) => m !== s.model) });
    else if (e.key === "[" || e.key === "]") {
      const i = EPS.indexOf(s.eps) + (e.key === "]" ? 1 : -1);
      if (i >= 0 && i < EPS.length) location.hash = href(qid, { ...s, eps: EPS[i] });
    }
  }
});
document.addEventListener("click", (e) => { const m = document.getElementById("menu"); if (m && !e.target.closest(".rel")) m.remove(); });
document.getElementById("kbdHelp").addEventListener("click", shortcuts);

// ---------- router ----------
function render() {
  const { parts, params } = parseRoute();
  keyHandlers.cert = null;
  try {
    if (parts[0] !== "thresholds") viewOther(parts[0]);
    else if (!parts[1]) viewList(params);
    else if (parts[1] === "refund_requested") viewNeedsLabels();
    else if (!DATA.questions.some((q) => q.id === parts[1])) { viewOther("missing"); }
    else if (parts[2] === "examples") viewExamples(parts[1], params);
    else viewCert(parts[1], params);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="alert alert-destructive" role="alert"><i data-lucide="circle-alert"></i><div><b>Something went wrong.</b> ${esc(err.message)}</div></div>`;
  }
  icons();
}
let lastPath = "";
window.addEventListener("hashchange", () => {
  const path = location.hash.split("?")[0];
  render();
  if (path !== lastPath) { window.scrollTo(0, 0); lastPath = path; }
});

async function boot() {
  try {
    const [d, r] = await Promise.all([fetch("data/decisions.json"), fetch("results/results.json")]);
    if (!d.ok || !r.ok) throw new Error(`data request failed (${d.status}/${r.status})`);
    DATA = await d.json(); RESULTS = await r.json();
    lastPath = location.hash.split("?")[0];
    render();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="alert alert-destructive" role="alert"><i data-lucide="circle-alert"></i><div><b>Could not load the labeled examples.</b> ${esc(err.message)}. Check your connection and try again.</div><div class="actions"><button class="btn btn-outline btn-sm" type="button" onclick="location.reload()">Retry</button></div></div>`;
    icons();
  }
}
if (window.lucide) boot(); else window.addEventListener("load", boot);
