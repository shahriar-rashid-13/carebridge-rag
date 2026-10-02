// Generates visit-note text for every pending slice through the Gemini API, saves it in output/,
// validates it, and sends fix requests for rows that fail. Replaces pasting slices into a chat UI.
//
// Usage (from carebridge-rag/):
//   node scripts/generate-llm.mjs                    all pending visit-note slices from B12 on
//   node scripts/generate-llm.mjs --limit 1          one slice (test run)
//   node scripts/generate-llm.mjs --from B20 --limit 10
//   node scripts/generate-llm.mjs --only B12-M01     one named slice, even if it already has output
//
// Options: --models <a,b,...> models to try in order (default GEMINI_MODELS or DEFAULT_MODELS below),
// --pace <ms> between requests (default 8000), --fixes <n> fix rounds per slice (default 2),
// --chunk <n> rows per request (default 25).
// Reads GEMINI_API_KEY from .env. Slices whose output already has every row are skipped, so a stopped
// run continues where it left off. When one model's daily free quota is used up the next model takes
// over; the run stops cleanly when every model is used up.
// Log: output/generate-llm.log (one JSON line per request, with token usage).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.mjs";
import { outputFilesFor, readOutputRows, validateSlice } from "./validate-batch.mjs";

const RAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_DIR = path.join(RAG_DIR, "manifest", "llm_input");
const OUTPUT_DIR = path.join(RAG_DIR, "output");
const LOG_FILE = path.join(OUTPUT_DIR, "generate-llm.log");
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_MODELS = "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-4-31b-it";

class QuotaExhausted extends Error {}

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(RAG_DIR, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing in .env");
  return env;
}

function parseArgs(argv) {
  const args = { from: "B12", limit: Infinity, only: null, models: null, pace: 8000, fixes: 2, chunk: 25 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (["limit", "pace", "fixes", "chunk"].includes(key)) args[key] = Number(value);
    else if (key in args) args[key] = value;
    else throw new Error(`Unknown option ${argv[i]}`);
    i++;
  }
  return args;
}

// The setup prompt is the first ````text block in GENERATION_PROMPT.md, minus its READY handshake.
function setupPrompt() {
  const doc = fs.readFileSync(path.join(RAG_DIR, "GENERATION_PROMPT.md"), "utf8").replace(/\r\n/g, "\n");
  const match = doc.match(/## Setup prompt[^\n]*\n+````text\n([\s\S]*?)\n````/);
  if (!match) throw new Error("Setup prompt not found in GENERATION_PROMPT.md");
  return match[1].replace(/\n*If you understand, reply only with: READY\s*$/, "").trim();
}

const readRows = (slice) =>
  fs.readFileSync(path.join(INPUT_DIR, `${slice}.jsonl`), "utf8").split(/\r?\n/).filter((l) => l.trim());

const foundIds = (slice) =>
  new Set(outputFilesFor(slice).flatMap((f) => readOutputRows(f, []).map((r) => r.doc_id)));

function visitNoteSlices() {
  return parseCsv(fs.readFileSync(path.join(RAG_DIR, "manifest", "batches.csv"), "utf8"))
    .slice(1)
    .filter((cells) => cells[1] === "visit_note")
    .map((cells) => cells[0]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

// Models are tried in order. A model whose daily quota is used up is dropped for the rest of the run;
// a model that stays overloaded (503) is skipped for the current request only.
function makeClient(env, args, system) {
  const models = (args.models ?? env.GEMINI_MODELS ?? DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
  let lastCall = 0;

  async function call(model, contents) {
    const wait = lastCall + args.pace - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    // Gemma models reject systemInstruction, so the setup prompt goes in front of the first message.
    const gemma = model.startsWith("gemma");
    const [first, ...rest] = contents;
    const request = gemma
      ? { contents: [{ ...first, parts: [{ text: `${system}\n\n${first.parts[0].text}` }] }, ...rest] }
      : { systemInstruction: { parts: [{ text: system }] }, contents };
    request.generationConfig = { temperature: 0.7, maxOutputTokens: gemma ? 8192 : 32768 };

    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(request),
    });
    return { res, body: await res.json().catch(() => ({})) };
  }

  return async function generate(contents, label) {
    for (let i = 0; i < models.length; ) {
      const model = models[i];
      let moveOn = false;
      for (let attempt = 1; !moveOn; attempt++) {
        const { res, body } = await call(model, contents);

        if (res.ok) {
          const candidate = body.candidates?.[0];
          const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
          log({ label, model, status: res.status, finish: candidate?.finishReason, usage: body.usageMetadata });
          return { text, finish: candidate?.finishReason };
        }

        const message = body.error?.message ?? `HTTP ${res.status}`;
        log({ label, model, status: res.status, error: message.slice(0, 300) });
        if (res.status === 429) {
          const violations = JSON.stringify(body.error?.details ?? []);
          if (/PerDay/i.test(violations) || /per day/i.test(message)) {
            console.log(`  daily quota for ${model} is used up`);
            models.splice(i, 1);
            moveOn = true;
            continue;
          }
          const retry = (body.error?.details ?? []).find((d) => d.retryDelay)?.retryDelay;
          const delay = retry ? Number.parseFloat(retry) * 1000 + 1000 : 30000 * attempt;
          console.log(`  ${model} rate limited, waiting ${Math.round(delay / 1000)} s`);
          await sleep(delay);
          continue;
        }
        if (res.status >= 500) {
          if (attempt < 3) {
            console.log(`  ${model}: ${message.slice(0, 60)}; retrying`);
            await sleep(10000 * attempt);
            continue;
          }
          i++;
          moveOn = true;
          continue;
        }
        throw new Error(`${label} (${model}): ${message}`);
      }
    }
    if (!models.length) throw new QuotaExhausted("Daily quota is used up for every model. Run the same command again after it resets.");
    throw new Error(`${label}: every model is overloaded right now`);
  };
}

function appendOutput(file, text) {
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const separator = previous && !previous.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${previous}${separator}${text.trim()}\n`);
}

async function generateSlice(slice, generate, args) {
  const rows = readRows(slice);
  const file = path.join(OUTPUT_DIR, `${slice}.csv`);
  if (args.only) for (const f of outputFilesFor(slice)) fs.rmSync(f);

  // Rows go out in chunks small enough to fit one reply. Rows still missing after a chunk are sent
  // again as a new request (max 2 retries per chunk) instead of asking the model to continue.
  // Rows already saved by an earlier, interrupted run are skipped.
  const idOf = (line) => JSON.parse(line).doc_id;
  const saved = foundIds(slice);
  for (let start = 0; start < rows.length; start += args.chunk) {
    let pending = rows.slice(start, start + args.chunk).filter((line) => !saved.has(idOf(line)));
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      const message = `BATCH ${slice}. ${pending.length} rows. Return CSV only, same order, header first.\n\n${pending.join("\n")}`;
      const label = `${slice} rows ${start + 1}-${start + pending.length}${attempt ? ` retry ${attempt}` : ""}`;
      const { text, finish } = await generate([{ role: "user", parts: [{ text: message }] }], label);
      // A reply cut off by the token limit ends in a half-written row; drop it so it is regenerated.
      appendOutput(file, finish === "MAX_TOKENS" ? text.trim().split(/\r?\n/).slice(0, -1).join("\n") : text);
      const found = foundIds(slice);
      pending = pending.filter((line) => !found.has(idOf(line)));
      if (pending.length) console.log(`  ${label}: ${pending.length} rows missing (${finish})`);
    }
  }

  let report = validateSlice(slice);
  for (let round = 1; round <= args.fixes && report.rows_failed > 0; round++) {
    const fixFile = path.join(OUTPUT_DIR, `${slice}.fix.txt`);
    console.log(`  ${report.rows_failed} rows failed; fix round ${round}`);
    const { text } = await generate([{ role: "user", parts: [{ text: fs.readFileSync(fixFile, "utf8") }] }], `${slice} fix ${round}`);
    let n = 1;
    while (fs.existsSync(path.join(OUTPUT_DIR, `${slice}.fix${n}.csv`))) n++;
    appendOutput(path.join(OUTPUT_DIR, `${slice}.fix${n}.csv`), text);
    report = validateSlice(slice);
  }
  return report;
}

async function main() {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const generate = makeClient(env, args, setupPrompt());

  const all = visitNoteSlices();
  let slices;
  if (args.only) {
    if (!all.includes(args.only)) throw new Error(`${args.only} is not a visit-note slice`);
    slices = [args.only];
  } else {
    const start = all.findIndex((s) => s >= args.from);
    slices = all
      .slice(start === -1 ? all.length : start)
      .filter((s) => foundIds(s).size < readRows(s).length)
      .slice(0, args.limit);
  }
  console.log(`${slices.length} slices to generate.`);

  const totals = { slices: 0, passed: 0, failed: 0 };
  for (const slice of slices) {
    const started = Date.now();
    try {
      const report = await generateSlice(slice, generate, args);
      totals.slices++;
      totals.passed += report.rows_passed;
      totals.failed += report.rows_failed;
      console.log(
        `${slice}: ${report.rows_passed}/${report.rows_expected} passed, ${report.rows_failed} failed ` +
          `(${Math.round((Date.now() - started) / 1000)} s)`,
      );
    } catch (error) {
      if (error instanceof QuotaExhausted) {
        console.log(error.message);
        break;
      }
      console.log(`${slice}: ${error.message}`);
    }
  }
  console.log(`Done: ${JSON.stringify(totals)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
