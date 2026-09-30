// Embeds corpus/corpus_clean.jsonl through the LiteLLM alias carebridge-embed and upserts the rows
// into Supabase public.rag_documents with the service role key.
//
// Usage: node scripts/embed-upload.mjs [--limit N] [--batch N] [--pace MS] [--force]
//   --limit N  only process the first N pending records (smoke test)
//   --batch N  records per embedding call (default 50)
//   --pace MS  pause between calls; the Gemini free tier allows about 100 texts per minute,
//              so use --batch 50 --pace 31000 for a full run
//   --force    re-embed records that already have an embedding
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LITELLM_BASE_URL, LITELLM_MASTER_KEY from .env.
// Safe to re-run: rows are upserted by doc_id and already embedded rows are skipped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus", "corpus_clean.jsonl");
const MODEL = "carebridge-embed";
const DIMENSIONS = 768;
const PACE_MS = 700;
const MAX_ATTEMPTS = 7;

const COLUMNS = [
  "doc_id",
  "record_type",
  "content",
  "specialization",
  "diagnosis",
  "faq_topic",
  "rag_visible",
  "is_noise",
  "noise_type",
  "source_doc_id",
];

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) throw new Error(".env not found in carebridge-rag/");
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LITELLM_BASE_URL", "LITELLM_MASTER_KEY"]) {
    if (!env[key]) throw new Error(`${key} missing in .env`);
  }
  return env;
}

function parseArgs(argv) {
  const args = { limit: Infinity, batch: 50, pace: PACE_MS, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--pace") args.pace = Number(argv[++i]);
    else if (argv[i] === "--batch") args.batch = Number(argv[++i]);
    else if (argv[i] === "--force") args.force = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    const res = await fn();
    if (res.ok) return res;
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${label} failed with HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const wait = Math.min(5000 * 2 ** (attempt - 1), 90000);
    console.log(`  ${label}: HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait / 1000}s`);
    await sleep(wait);
  }
}

function supabaseHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  // New sb_secret_ keys are not JWTs and only go in the apikey header.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function fetchEmbeddedIds(env) {
  const done = new Set();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${env.SUPABASE_URL}/rest/v1/rag_documents?select=doc_id&embedding=not.is.null&order=doc_id&limit=${pageSize}&offset=${offset}`;
    const res = await withRetry("read existing", () => fetch(url, { headers: supabaseHeaders(env) }));
    const rows = await res.json();
    for (const row of rows) done.add(row.doc_id);
    if (rows.length < pageSize) return done;
  }
}

async function embed(env, texts) {
  const res = await withRetry("embed", () =>
    fetch(`${env.LITELLM_BASE_URL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: texts }),
    }),
  );
  const json = await res.json();
  const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new Error(`embed returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  for (const v of vectors) {
    if (v.length !== DIMENSIONS) throw new Error(`embed returned ${v.length} dimensions, expected ${DIMENSIONS}`);
  }
  return vectors;
}

async function upsert(env, rows) {
  await withRetry("upsert", () =>
    fetch(`${env.SUPABASE_URL}/rest/v1/rag_documents?on_conflict=doc_id`, {
      method: "POST",
      headers: { ...supabaseHeaders(env), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    }),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  const records = fs
    .readFileSync(CORPUS, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const done = args.force ? new Set() : await fetchEmbeddedIds(env);
  const pending = records.filter((r) => !done.has(r.doc_id)).slice(0, args.limit);
  console.log(`Corpus ${records.length}, already embedded ${done.size}, to process ${pending.length}`);

  const started = Date.now();
  let processed = 0;
  for (let i = 0; i < pending.length; i += args.batch) {
    const batch = pending.slice(i, i + args.batch);
    const vectors = await embed(env, batch.map((r) => r.content));
    const rows = batch.map((r, j) => {
      const row = Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null]));
      row.rag_visible = r.rag_visible !== false;
      row.is_noise = r.is_noise === true;
      row.embedding = `[${vectors[j].join(",")}]`;
      return row;
    });
    await upsert(env, rows);
    processed += batch.length;
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`  ${processed}/${pending.length} done (${batch[0].doc_id}..${batch.at(-1).doc_id}, ${secs}s)`);
    if (i + args.batch < pending.length) await sleep(args.pace);
  }
  console.log("Finished.");
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  console.error("Re-run the same command to continue; finished rows are skipped.");
  process.exit(1);
});
