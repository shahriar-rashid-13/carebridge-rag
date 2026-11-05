#!/usr/bin/env node
/**
 * Assessment 4 Option 1 — RAGAS harness skeleton (carebridge-rag).
 *
 * Loads eval/ragas-golden-set.json and produces RAGAS-shaped scores for:
 *   faithfulness, answer_relevance, context_precision, context_recall
 *
 * Modes:
 *   --mode offline   (default) Mock answers from golden ground_truth +
 *                    reference_contexts. Lexical overlap proxies only —
 *                    NO LiteLLM / LITELLM_MASTER_KEY required.
 *   --mode live      Skeleton for tomorrow: requires LITELLM_MASTER_KEY
 *                    (+ optional RAG endpoint). Exits with a clear error
 *                    today until live wiring lands.
 *
 * Usage:
 *   node scripts/ragas-eval.mjs
 *   node scripts/ragas-eval.mjs --mode offline
 *   node scripts/ragas-eval.mjs --mode offline --limit 5
 *   node scripts/ragas-eval.mjs --mode live
 *
 * Writes:
 *   eval/ragas-results.json
 *   eval/RAGAS_EVAL_REPORT.md
 *
 * Out of scope today: Langfuse, live agentic RAG answers, hard CI fail.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "eval");
const GOLDEN_PATH = path.join(EVAL_DIR, "ragas-golden-set.json");
const RESULTS_PATH = path.join(EVAL_DIR, "ragas-results.json");
const REPORT_PATH = path.join(EVAL_DIR, "RAGAS_EVAL_REPORT.md");

/** Planned hard CI floors for tomorrow (live RAGAS). Not enforced offline. */
export const PLANNED_THRESHOLDS = {
  faithfulness: 0.7,
  answer_relevance: 0.7,
  context_precision: 0.55,
  context_recall: 0.55,
  note:
    "Draft floors for tomorrow's hard gate. Re-derive from the first live RAGAS run vs locked A3b — do not invent final numbers from offline proxies.",
};

const METRICS = [
  "faithfulness",
  "answer_relevance",
  "context_precision",
  "context_recall",
];

function parseArgs(argv) {
  const out = { mode: "offline", limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") out.mode = String(argv[++i] || "").toLowerCase();
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  if (out.mode !== "offline" && out.mode !== "live") {
    throw new Error(`--mode must be offline or live (got ${out.mode})`);
  }
  if (out.limit != null && (!Number.isFinite(out.limit) || out.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  return out;
}

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * Offline proxy scores (NOT real RAGAS). Uses golden answer + reference
 * contexts so CI can exercise the pipeline without secrets.
 */
function scoreOfflineItem(item) {
  const question = item.question || "";
  const answer = item.ground_truth || "";
  const contexts = Array.isArray(item.reference_contexts)
    ? item.reference_contexts
    : [];
  const ctxText = contexts.join("\n");
  const qTok = tokenize(question);
  const aTok = tokenize(answer);
  const cTok = tokenize(ctxText);

  if (item.expect_refuse) {
    // Refusal items: treat a non-inventing refusal as high faithfulness /
    // relevance; context metrics stay null (no retrieval expected).
    const refuses =
      /cannot|don't know|do not know|out of scope|unsupported|not able|unable|refuse/i.test(
        answer,
      );
    return {
      faithfulness: refuses ? 1 : 0.5,
      answer_relevance: refuses ? 1 : 0.5,
      context_precision: null,
      context_recall: null,
      refused: true,
      answer,
      contexts,
      scoring: "offline_proxy_refusal",
    };
  }

  const faith = clamp01(jaccard(aTok, cTok));
  const rel = clamp01(0.5 * jaccard(aTok, qTok) + 0.5 * jaccard(aTok, cTok));
  const prec = clamp01(jaccard(cTok, aTok));
  const recall = clamp01(jaccard(cTok, tokenize(item.ground_truth)));

  return {
    faithfulness: faith,
    answer_relevance: rel,
    context_precision: prec,
    context_recall: recall,
    refused: false,
    answer,
    contexts,
    scoring: "offline_proxy_lexical",
  };
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function byCategoryMeans(perItem) {
  const buckets = {};
  for (const row of perItem) {
    const cat = row.category || "unknown";
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push(row);
  }
  const out = {};
  for (const [cat, rows] of Object.entries(buckets)) {
    out[cat] = {
      n: rows.length,
      faithfulness: mean(rows.map((r) => r.faithfulness)),
      answer_relevance: mean(rows.map((r) => r.answer_relevance)),
      context_precision: mean(rows.map((r) => r.context_precision)),
      context_recall: mean(rows.map((r) => r.context_recall)),
    };
  }
  return out;
}

function round4(n) {
  if (n == null) return null;
  return Math.round(n * 10000) / 10000;
}

function writeReport(payload) {
  const agg = payload.aggregate;
  const lines = [
    `# RAGAS evaluation report (skeleton)`,
    ``,
    `**Mode:** \`${payload.mode}\``,
    `**Scoring:** \`${payload.scoring}\``,
    `**Golden set:** \`eval/ragas-golden-set.json\` (${payload.n_items} items)`,
    `**Run at:** ${payload.run_at}`,
    `**Real RAGAS?** ${payload.real_ragas ? "yes" : "**no** — offline lexical proxies / placeholder"}`,
    ``,
    `## Aggregate (0–1)`,
    ``,
    `| Metric | Score | Planned hard floor (tomorrow) |`,
    `|---|---:|---:|`,
    ...METRICS.map(
      (m) =>
        `| ${m} | ${agg[m] == null ? "—" : agg[m].toFixed(4)} | ${PLANNED_THRESHOLDS[m]} |`,
    ),
    ``,
    `## By category`,
    ``,
    `| Category | n | Faithfulness | Answer relevance | Context precision | Context recall |`,
    `|---|---:|---:|---:|---:|---:|`,
    ...Object.entries(payload.by_category).map(([cat, row]) => {
      const fmt = (v) => (v == null ? "—" : v.toFixed(4));
      return `| ${cat} | ${row.n} | ${fmt(row.faithfulness)} | ${fmt(row.answer_relevance)} | ${fmt(row.context_precision)} | ${fmt(row.context_recall)} |`;
    }),
    ``,
    `## A3 baseline bridge`,
    ``,
    `- Locked A3b (project store \`docs/a3-rag-baseline.md\`): Hit@5 / MRR / P@5 and 1–5 judge scores.`,
    `- Do **not** treat A3 faithfulness/relevance 5.00 as RAGAS 1.0.`,
    `- Live RAGAS tomorrow re-scores the same golden set; offline proxies above are **not** comparable to A3.`,
    ``,
    `## How to fill real scores (tomorrow)`,
    ``,
    `1. Set \`LITELLM_BASE_URL\` + \`LITELLM_MASTER_KEY\` (and RAG endpoint env as wired).`,
    `2. Run live mode: \`node scripts/ragas-eval.mjs --mode live\` (or \`python scripts/ragas-eval-live.py\` once wired).`,
    `3. Replace this report + \`eval/ragas-results.json\` with real RAGAS output.`,
    `4. Derive final CI hard floors from that live run; update \`PLANNED_THRESHOLDS\` / gate config.`,
    `5. Project-store mirror: \`docs/a4-ragas-results.md\` in the CareBridge agent store.`,
    ``,
    `## Out of scope`,
    ``,
    `- Langfuse (deferred).`,
    `- Hard CI fail on thresholds (soft-skip until secrets + live scores exist).`,
    ``,
  ];
  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
}

function runOffline(golden, limit) {
  let items = golden.items || [];
  if (limit) items = items.slice(0, limit);

  const perItem = items.map((item) => {
    const scored = scoreOfflineItem(item);
    return {
      id: item.id,
      category: item.category,
      a3_fixture: item.a3_fixture ?? null,
      expect_refuse: Boolean(item.expect_refuse),
      multi_hop: Boolean(item.multi_hop),
      question: item.question,
      ...scored,
      faithfulness: round4(scored.faithfulness),
      answer_relevance: round4(scored.answer_relevance),
      context_precision: round4(scored.context_precision),
      context_recall: round4(scored.context_recall),
    };
  });

  const aggregate = {
    faithfulness: round4(mean(perItem.map((r) => r.faithfulness))),
    answer_relevance: round4(mean(perItem.map((r) => r.answer_relevance))),
    context_precision: round4(mean(perItem.map((r) => r.context_precision))),
    context_recall: round4(mean(perItem.map((r) => r.context_recall))),
  };

  const by_category = byCategoryMeans(perItem);
  for (const row of Object.values(by_category)) {
    for (const m of METRICS) row[m] = round4(row[m]);
  }

  return {
    about:
      "A4 Option 1 RAGAS harness skeleton results. Offline mode uses lexical proxies — not real RAGAS.",
    schema_version: 1,
    assessment: "A4-Option1-Step4-skeleton",
    mode: "offline",
    scoring: "offline_proxy_lexical",
    real_ragas: false,
    golden_set: "eval/ragas-golden-set.json",
    a3_baseline_lock: golden.a3_baseline_lock || "A3b",
    run_at: new Date().toISOString(),
    n_items: perItem.length,
    metrics: METRICS,
    planned_thresholds: PLANNED_THRESHOLDS,
    aggregate,
    by_category,
    items: perItem,
    live_mode_tomorrow: {
      command: "node scripts/ragas-eval.mjs --mode live",
      alt_python: "python scripts/ragas-eval-live.py",
      requires: [
        "LITELLM_BASE_URL",
        "LITELLM_MASTER_KEY",
        "Live RAG answer path (agentic) returning answer + retrieved contexts",
      ],
      metrics: METRICS,
    },
  };
}

function runLiveSkeleton() {
  const fileEnv = loadEnvFile();
  const key =
    process.env.LITELLM_MASTER_KEY || fileEnv.LITELLM_MASTER_KEY || "";
  const base =
    process.env.LITELLM_BASE_URL || fileEnv.LITELLM_BASE_URL || "";

  if (!key) {
    const err = new Error(
      "Live mode requires LITELLM_MASTER_KEY (env or .env). Offline mode needs no secrets: node scripts/ragas-eval.mjs --mode offline",
    );
    err.code = "MISSING_SECRETS";
    throw err;
  }

  // Skeleton only — real RAGAS + live RAG wiring is tomorrow's work.
  throw new Error(
    [
      "Live RAGAS mode is scaffolded but not wired yet.",
      `Found LITELLM_MASTER_KEY (${key.slice(0, 4)}…) and LITELLM_BASE_URL=${base || "(unset)"}.`,
      "Tomorrow: call live agentic RAG per golden item, then score with ragas",
      "(see scripts/ragas-eval-live.py) via LiteLLM OpenAI-compatible endpoint.",
      "Langfuse is explicitly out of scope for this skeleton.",
    ].join(" "),
  );
}

function printHelp() {
  console.log(`RAGAS harness skeleton

Usage:
  node scripts/ragas-eval.mjs [--mode offline|live] [--limit N]

Offline (default): no LITELLM_MASTER_KEY; lexical proxy scores → eval/ragas-results.json
Live:              requires secrets; stub until tomorrow's wiring
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(GOLDEN_PATH)) {
    throw new Error(`Missing golden set at ${GOLDEN_PATH}`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

  if (args.mode === "live") {
    runLiveSkeleton();
    return;
  }

  const payload = runOffline(golden, args.limit);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2) + "\n");
  writeReport(payload);

  console.log(
    `Offline RAGAS skeleton: ${payload.n_items} items → ${path.relative(ROOT, RESULTS_PATH)}`,
  );
  console.log(
    `Aggregate: faith=${payload.aggregate.faithfulness} rel=${payload.aggregate.answer_relevance} prec=${payload.aggregate.context_precision} recall=${payload.aggregate.context_recall}`,
  );
  console.log(`Report: ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(
    "NOTE: scores are offline lexical proxies, not real RAGAS. Live mode tomorrow.",
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(err.code === "MISSING_SECRETS" ? 2 : 1);
  }
}
