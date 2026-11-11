// Turn the compact column store in data/decisions.json into per-request items.

/** Items for one question and model: { i, s (top-choice probability), ok (1 if right), gold, choice, choice2, p2 }. */
export function itemsFor(question, model) {
  const m = question.models[model];
  if (!m) throw new Error(`no ${model} run for ${question.id}`);
  return question.gold.map((gold, i) => ({
    i,
    s: m.p[i],
    ok: m.choice[i] === gold ? 1 : 0,
    gold,
    choice: m.choice[i],
    choice2: m.choice2[i],
    p2: m.p2[i],
  }));
}

/** Readable label: banking intents and CLINC intents are snake_case keys. */
export function labelName(key) {
  if (key === "oos") return "out of scope";
  return key.replace(/_/g, " ");
}
