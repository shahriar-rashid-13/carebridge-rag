// Compares gte-small embeddings computed locally (transformers.js) with the ones the Supabase Edge
// Runtime produces (embed-check function), so stored document vectors and live query vectors are
// known to come from the same model. Prints the cosine similarity per text; all should be above 0.999.
//
// Usage: node scripts/check-gte.mjs
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus", "corpus_clean.jsonl");
const THRESHOLD = 0.999;

const QUESTIONS = [
  "How do I cancel my appointment?",
  "What should I do if I miss my slot?",
  "chest pain when climbing stairs",
  "itchy red rash on both arms",
  "Can I get a refund if the doctor cancels?",
];

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!env[key]) throw new Error(`${key} missing in .env`);
  }
  return env;
}

const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function main() {
  const env = loadEnv();
  const records = fs.readFileSync(CORPUS, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const sample = ["faq", "visit_note", "prescription"].flatMap((type) =>
    records.filter((r) => r.record_type === type && r.content.length <= 2000).slice(0, 5).map((r) => r.content),
  );
  const texts = [...QUESTIONS, ...sample];

  const extractor = await pipeline("feature-extraction", "Supabase/gte-small", { dtype: "fp32" });
  const local = (await extractor(texts, { pooling: "mean", normalize: true })).tolist();

  // One text per request: the Edge Runtime CPU limit stops a worker that embeds many long texts.
  const edge = [];
  for (const text of texts) {
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/embed-check`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ texts: [text] }),
    });
    if (!res.ok) throw new Error(`embed-check failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    edge.push((await res.json()).embeddings[0]);
  }

  let worst = 1;
  texts.forEach((text, i) => {
    const sim = cosine(local[i], edge[i]);
    worst = Math.min(worst, sim);
    console.log(`${sim.toFixed(6)}  ${text.slice(0, 60).replace(/\s+/g, " ")}`);
  });
  console.log(`\nLowest cosine ${worst.toFixed(6)}; ${worst >= THRESHOLD ? "PASS" : "FAIL"} (threshold ${THRESHOLD})`);
  if (worst < THRESHOLD) process.exit(1);
}

main().catch((err) => {
  console.error(`Stopped: ${err.message}`);
  process.exit(1);
});
