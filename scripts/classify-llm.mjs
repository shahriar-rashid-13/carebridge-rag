// Track 4, LLM variant: zero-shot specialization routing with the CareBridge chat model
// (LiteLLM model group carebridge-agent, Gemini 3.1 Flash Lite with fallbacks).
//
// Test sets: the 48 hand-written descriptions (eval/symptom-queries.json) and a stratified sample of
// the held-out visit notes in stress form (first sentence plus typos) written by classify-eval.py.
//
// Usage: node scripts/classify-llm.mjs [--per-class N]   (default 10 held-out notes per class)
// Writes eval/classification-llm-results.json and appends nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "eval");
const BATCH = 16;
const SPECIALIZATIONS = [
  "General Medicine", "Cardiology", "Pulmonology", "Gastroenterology", "Endocrinology", "Dermatology",
  "Orthopedics", "Neurology", "ENT", "Ophthalmology", "Obstetrics and Gynecology", "Psychiatry",
];

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classify(env, texts) {
  const prompt = [
    "You route clinic patients to a specialization. For each numbered symptom description, choose exactly one of:",
    SPECIALIZATIONS.join(", ") + ".",
    'Reply with only a JSON array of strings, one per description, in order. Example: ["ENT","Cardiology"].',
    "",
    ...texts.map((t, i) => `${i + 1}. ${t}`),
  ].join("\n");
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${env.LITELLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "carebridge-agent", temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    if (res.ok) {
      const json = await res.json();
      const group = res.headers.get("x-litellm-model-group");
      const text = json.choices?.[0]?.message?.content ?? "";
      const match = text.match(/\[[\s\S]*\]/);
      const labels = match ? JSON.parse(match[0]) : [];
      if (labels.length === texts.length) return { labels, group, model: json.model };
      console.log(`  got ${labels.length} labels for ${texts.length} texts, retrying`);
    } else {
      console.log(`  HTTP ${res.status}, retrying`);
    }
    await sleep(5000 * attempt);
  }
  throw new Error("classification failed after 4 attempts");
}

async function run(env, name, items) {
  const predictions = [];
  const groups = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const { labels, group } = await classify(env, batch.map((x) => x.text));
    predictions.push(...labels);
    groups[group] = (groups[group] ?? 0) + 1;
    console.log(`  ${name}: ${Math.min(i + BATCH, items.length)}/${items.length}`);
    await sleep(3000);
  }
  const correct = items.filter((x, i) => predictions[i] === x.label).length;
  return {
    n: items.length,
    accuracy: correct / items.length,
    model_groups: groups,
    errors: items
      .map((x, i) => ({ text: x.text, true: x.label, predicted: predictions[i] }))
      .filter((e) => e.true !== e.predicted),
  };
}

async function main() {
  const perClass = Number(process.argv[process.argv.indexOf("--per-class") + 1]) || 10;
  const env = loadEnv();
  const handwritten = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "symptom-queries.json"), "utf8")).items;
  const heldOut = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, ".cache", "classify-test.json"), "utf8"));
  const sample = SPECIALIZATIONS.flatMap((s) =>
    heldOut.filter((x) => x.label === s).slice(0, perClass).map((x) => ({ text: x.stress_text, label: x.label, doc_id: x.doc_id })),
  );

  const result = {
    run_at: new Date().toISOString(),
    model: "LiteLLM carebridge-agent (gemini/gemini-3.1-flash-lite, OpenRouter fallbacks), zero-shot, temperature 0",
    handwritten: await run(env, "hand-written", handwritten),
    held_out_stress_sample: await run(env, "held-out stress", sample),
  };
  fs.writeFileSync(path.join(EVAL_DIR, "classification-llm-results.json"), JSON.stringify(result, null, 2));
  console.log(`hand-written: ${(result.handwritten.accuracy * 100).toFixed(1)}% on ${result.handwritten.n}`);
  console.log(`held-out stress sample: ${(result.held_out_stress_sample.accuracy * 100).toFixed(1)}% on ${result.held_out_stress_sample.n}`);
  console.log("Wrote eval/classification-llm-results.json");
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  process.exit(1);
});
