// Upserts every corpus record into Supabase public.rag_documents together with its gte-small vector
// from embeddings/gte-small.jsonl (written by embed-gte.mjs). Existing rows keep their Gemini
// embedding because that column is not sent.
//
// Usage: node scripts/upload-gte.mjs [--limit N] [--batch N]
//   --limit N  only upload the first N records (smoke test)
//   --batch N  rows per request (default 200)
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env. Safe to re-run: rows are upserted by doc_id.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus", "corpus_clean.jsonl");
const EMBEDDINGS = path.join(ROOT, "embeddings", "gte-small.jsonl");
const MAX_ATTEMPTS = 5;

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
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!env[key]) throw new Error(`${key} missing in .env`);
  }
  return env;
}

function parseArgs(argv) {
  const args = { limit: Infinity, batch: 200 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--batch") args.batch = Number(argv[++i]);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return args;
}

const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function supabaseHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  // New sb_secret_ keys are not JWTs and only go in the apikey header.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function upsert(env, rows) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rag_documents?on_conflict=doc_id`, {
      method: "POST",
      headers: { ...supabaseHeaders(env), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (res.ok) return;
    const body = await res.text();
    if ((res.status !== 429 && res.status < 500) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`upsert failed with HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    await sleep(3000 * attempt);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  const vectors = new Map(readJsonl(EMBEDDINGS).map((r) => [r.doc_id, r.embedding]));
  const records = readJsonl(CORPUS);
  const missing = records.filter((r) => !vectors.has(r.doc_id));
  if (missing.length) throw new Error(`${missing.length} records have no gte-small vector; run embed-gte.mjs first`);

  // source_doc_id references another row, so source records go before the noise copies.
  const ordered = [...records.filter((r) => !r.source_doc_id), ...records.filter((r) => r.source_doc_id)].slice(
    0,
    args.limit,
  );
  console.log(`Uploading ${ordered.length} of ${records.length} records`);

  const started = Date.now();
  for (let i = 0; i < ordered.length; i += args.batch) {
    const rows = ordered.slice(i, i + args.batch).map((r) => {
      const row = Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null]));
      row.rag_visible = r.rag_visible !== false;
      row.is_noise = r.is_noise === true;
      row.embedding_gte = `[${vectors.get(r.doc_id).join(",")}]`;
      return row;
    });
    await upsert(env, rows);
    const done = Math.min(i + args.batch, ordered.length);
    if (done % (args.batch * 10) === 0 || done === ordered.length) {
      console.log(`  ${done}/${ordered.length} done (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  }
  console.log("Finished.");
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  console.error("Re-run the same command; rows are upserted by doc_id.");
  process.exit(1);
});
