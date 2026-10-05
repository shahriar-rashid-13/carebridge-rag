// Embeds corpus/corpus_clean.jsonl locally with Supabase/gte-small (384 dimensions, mean pooling,
// normalised) and appends one {doc_id, tokens, embedding} line per record to embeddings/gte-small.jsonl.
// No API key or network call is needed after the first run downloads the model (about 30 MB).
//
// Usage: node scripts/embed-gte.mjs [--limit N] [--batch N] [--force]
//   --limit N  only process the first N pending records (smoke test)
//   --batch N  records per model call (default 32)
//   --force    delete the output file and embed everything again
//
// Safe to re-run: records already in the output file are skipped.
// gte-small reads at most 512 tokens; longer records are truncated and listed in the report.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus", "corpus_clean.jsonl");
const OUT_DIR = path.join(ROOT, "embeddings");
const OUT = path.join(OUT_DIR, "gte-small.jsonl");
const REPORT = path.join(OUT_DIR, "gte-small.report.json");
const MODEL = "Supabase/gte-small";
const DIMENSIONS = 384;
const MAX_TOKENS = 512;

function parseArgs(argv) {
  const args = { limit: Infinity, batch: 32, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--batch") args.batch = Number(argv[++i]);
    else if (argv[i] === "--force") args.force = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return args;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function check(vector, docId) {
  if (vector.length !== DIMENSIONS) {
    throw new Error(`${docId}: ${vector.length} dimensions, expected ${DIMENSIONS}`);
  }
  const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
  if (Math.abs(norm - 1) > 1e-3) throw new Error(`${docId}: vector length ${norm}, expected 1`);
}

function writeReport(rows, corpusSize, seconds) {
  const tokens = rows.map((r) => r.tokens).sort((a, b) => a - b);
  const truncated = rows.filter((r) => r.tokens > MAX_TOKENS);
  const report = {
    model: MODEL,
    dimensions: DIMENSIONS,
    corpus_records: corpusSize,
    embedded: rows.length,
    tokens: {
      min: tokens[0],
      median: tokens[Math.floor(tokens.length / 2)],
      p95: tokens[Math.floor(tokens.length * 0.95)],
      max: tokens.at(-1),
    },
    truncated_count: truncated.length,
    truncated: truncated.map((r) => ({ doc_id: r.doc_id, tokens: r.tokens })),
    last_run_seconds: seconds,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (args.force && fs.existsSync(OUT)) fs.unlinkSync(OUT);

  const records = readJsonl(CORPUS);
  const done = new Set(readJsonl(OUT).map((r) => r.doc_id));
  const pending = records.filter((r) => !done.has(r.doc_id)).slice(0, args.limit);
  console.log(`Corpus ${records.length}, already embedded ${done.size}, to process ${pending.length}`);

  const extractor = await pipeline("feature-extraction", MODEL, { dtype: "fp32" });
  const started = Date.now();

  for (let i = 0; i < pending.length; i += args.batch) {
    const batch = pending.slice(i, i + args.batch);
    const texts = batch.map((r) => r.content);
    const tokenCounts = texts.map((t) => extractor.tokenizer.encode(t).length);
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const vectors = output.tolist();

    const lines = batch.map((r, j) => {
      check(vectors[j], r.doc_id);
      const embedding = vectors[j].map((x) => Math.round(x * 1e6) / 1e6);
      return JSON.stringify({ doc_id: r.doc_id, tokens: tokenCounts[j], embedding });
    });
    fs.appendFileSync(OUT, lines.join("\n") + "\n");

    const processed = Math.min(i + args.batch, pending.length);
    const secs = Math.round((Date.now() - started) / 1000);
    if (processed % (args.batch * 20) === 0 || processed === pending.length) {
      console.log(`  ${processed}/${pending.length} done (${secs}s)`);
    }
  }

  const report = writeReport(readJsonl(OUT), records.length, Math.round((Date.now() - started) / 1000));
  console.log(
    `Finished. ${report.embedded}/${report.corpus_records} embedded, ` +
      `${report.truncated_count} over ${MAX_TOKENS} tokens, median ${report.tokens.median} tokens.`,
  );
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  console.error("Re-run the same command to continue; finished records are skipped.");
  process.exit(1);
});
