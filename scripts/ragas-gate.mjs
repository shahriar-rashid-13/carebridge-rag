#!/usr/bin/env node
/**
 * Assessment 4 Option 1 — RAGAS CI gate skeleton.
 *
 * Soft gate (default / no LITELLM_MASTER_KEY):
 *   - Missing key → soft-skip / pass with warning (exit 0) so forks stay green.
 *   - Offline/placeholder results → pass with warning unless --hard.
 *
 * Hard gate (--hard or RAGAS_GATE_HARD=1) when secrets + live results exist:
 *   - Require real_ragas=true.
 *   - Fail if aggregate metrics fall below eval/ragas-thresholds.json floors.
 *
 * Usage:
 *   node scripts/ragas-gate.mjs
 *   node scripts/ragas-gate.mjs --results eval/ragas-results.json
 *   RAGAS_GATE_HARD=1 node scripts/ragas-gate.mjs --hard
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLANNED_THRESHOLDS } from "./ragas-eval.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RESULTS = path.join(ROOT, "eval", "ragas-results.json");

const METRICS = [
  "faithfulness",
  "answer_relevance",
  "context_precision",
  "context_recall",
];

function parseArgs(argv) {
  const out = { results: DEFAULT_RESULTS, hard: process.env.RAGAS_GATE_HARD === "1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--results") out.results = path.resolve(ROOT, argv[++i]);
    else if (argv[i] === "--hard") out.hard = true;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
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

function hasLiteLLMKey() {
  const fromEnv = (process.env.LITELLM_MASTER_KEY || "").trim();
  if (fromEnv) return true;
  const fileEnv = loadEnvFile();
  return Boolean((fileEnv.LITELLM_MASTER_KEY || "").trim());
}

function loadThresholds() {
  const p = path.join(ROOT, "eval", "ragas-thresholds.json");
  if (!fs.existsSync(p)) return PLANNED_THRESHOLDS;
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  return { ...PLANNED_THRESHOLDS, ...(doc.metrics || {}), note: doc.about };
}

function warn(msg) {
  console.warn(`::warning::${msg}`);
  console.warn(`WARNING: ${msg}`);
}

function compareThresholds(aggregate, thresholds) {
  const failures = [];
  for (const m of METRICS) {
    const score = aggregate?.[m];
    const floor = thresholds[m];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      failures.push(`${m}: missing score`);
      continue;
    }
    if (score < floor) {
      failures.push(`${m}: ${score} < floor ${floor}`);
    }
  }
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`RAGAS CI gate skeleton

  node scripts/ragas-gate.mjs [--results PATH] [--hard]

Soft (default): missing secrets or offline results → exit 0 with warning
Hard (--hard or RAGAS_GATE_HARD=1): enforce planned thresholds on real_ragas results
`);
    return;
  }

  const thresholds = loadThresholds();

  console.log("RAGAS gate skeleton");
  console.log(`Results path: ${args.results}`);
  console.log(`Hard mode: ${args.hard ? "yes" : "no (soft)"}`);
  console.log("Planned tomorrow thresholds:", JSON.stringify(thresholds));

  if (!hasLiteLLMKey()) {
    warn(
      "LITELLM_MASTER_KEY missing — soft-skipping RAGAS gate (pass). Live hard gate tomorrow once secrets + real RAGAS scores exist.",
    );
    console.log("Gate decision: SOFT PASS (secrets missing)");
    process.exit(0);
  }

  if (!fs.existsSync(args.results)) {
    if (args.hard) {
      console.error(`Hard gate: missing results file ${args.results}`);
      process.exit(1);
    }
    warn(
      `No results at ${args.results} — soft-skipping RAGAS gate. Run: node scripts/ragas-eval.mjs --mode offline`,
    );
    console.log("Gate decision: SOFT PASS (no results)");
    process.exit(0);
  }

  const results = JSON.parse(fs.readFileSync(args.results, "utf8"));
  const real = Boolean(results.real_ragas);
  const mode = results.mode || "unknown";

  console.log(`Loaded results: mode=${mode} real_ragas=${real} n=${results.n_items ?? "?"}`);
  console.log("Aggregate:", JSON.stringify(results.aggregate || {}));

  if (!real) {
    warn(
      `Results are not real RAGAS (mode=${mode}). Soft-pass today. Tomorrow: produce real_ragas=true then enable hard gate.`,
    );
    if (args.hard) {
      console.error("Hard gate refuses offline/placeholder results.");
      process.exit(1);
    }
    console.log("Gate decision: SOFT PASS (offline/placeholder results)");
    process.exit(0);
  }

  const failures = compareThresholds(results.aggregate, thresholds);
  if (failures.length) {
    const msg = `RAGAS threshold failures: ${failures.join("; ")}`;
    if (args.hard) {
      console.error(msg);
      console.log("Gate decision: FAIL");
      process.exit(1);
    }
    warn(`${msg} — soft mode still passes. Re-run with --hard tomorrow.`);
    console.log("Gate decision: SOFT PASS (would fail hard mode)");
    process.exit(0);
  }

  console.log("Gate decision: PASS (all planned thresholds met)");
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
