// Clipboard helper for generating record text in a chat UI (DeepSeek, ChatGPT) slice by slice.
//
// Usage (from carebridge-rag/, Windows):
//   node scripts/chat-helper.mjs next [B12]   copy the next slice without output (optionally from a batch on)
//   node scripts/chat-helper.mjs copy B12-M03 copy one slice's batch message
//   node scripts/chat-helper.mjs save         append the copied chat reply to output/<current slice>.csv
//   node scripts/chat-helper.mjs fix          copy output/<current slice>.fix.txt (after a failed validation)
//   node scripts/chat-helper.mjs savefix      save the copied fix reply as output/<current slice>.fixN.csv
//   node scripts/chat-helper.mjs status       count done and pending visit-note slices
//
// "save" can run several times for one slice (reply cut short, then CONTINUE): each reply is appended.
// When every row is present, the slice is validated automatically.
// Only visit-note slices are offered; prescription slices are filled by render-prescriptions.mjs.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.mjs";
import { outputFilesFor, readOutputRows, validateSlice } from "./validate-batch.mjs";

const RAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_DIR = path.join(RAG_DIR, "manifest", "llm_input");
const OUTPUT_DIR = path.join(RAG_DIR, "output");
const CURRENT_FILE = path.join(OUTPUT_DIR, ".chat-current");

const powershell = (command, input) =>
  execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const setClipboard = (text) =>
  powershell("[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())", text);

const getClipboard = () =>
  powershell("[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw") ?? "";

const readRows = (slice) =>
  fs.readFileSync(path.join(INPUT_DIR, `${slice}.jsonl`), "utf8").split(/\r?\n/).filter((l) => l.trim());

function visitNoteSlices() {
  return parseCsv(fs.readFileSync(path.join(RAG_DIR, "manifest", "batches.csv"), "utf8"))
    .slice(1)
    .filter((cells) => cells[1] === "visit_note")
    .map((cells) => cells[0]);
}

const hasOutput = (slice) => outputFilesFor(slice).some((f) => fs.statSync(f).size > 0);

function currentSlice() {
  if (!fs.existsSync(CURRENT_FILE)) throw new Error("No current slice. Run `next` or `copy <slice>` first.");
  return fs.readFileSync(CURRENT_FILE, "utf8").trim();
}

function copySlice(slice) {
  const rows = readRows(slice);
  const message = `BATCH ${slice}. ${rows.length} rows. Return CSV only, same order, header first.\n\n${rows.join("\n")}\n`;
  setClipboard(message);
  fs.writeFileSync(CURRENT_FILE, slice);
  const batchStart = slice.endsWith("-M01");
  console.log(`Copied ${slice} (${rows.length} rows, ${rows[0] && JSON.parse(rows[0]).doc_id} to ${JSON.parse(rows.at(-1)).doc_id}).`);
  if (batchStart) console.log("New batch: start a fresh chat and paste the setup prompt first.");
  console.log("Paste it into the chat. Copy the whole reply, then run: node scripts/chat-helper.mjs save");
}

function report(slice) {
  const expected = readRows(slice).length;
  const found = new Set(outputFilesFor(slice).flatMap((f) => readOutputRows(f, []).map((r) => r.doc_id))).size;
  if (found < expected) {
    console.log(`${slice}: ${found}/${expected} rows so far. Reply CONTINUE in the chat, copy the reply, and run save again.`);
    return;
  }
  const result = validateSlice(slice);
  console.log(`${slice}: ${result.rows_passed}/${result.rows_expected} passed, ${result.rows_failed} failed.`);
  for (const problem of result.file_problems) console.log(`  ${problem}`);
  if (result.rows_failed) console.log("Run: node scripts/chat-helper.mjs fix   (copies the fix message for the same chat)");
  else console.log("Done. Run: node scripts/chat-helper.mjs next");
}

function save(fix) {
  const slice = currentSlice();
  const text = getClipboard().replace(/\r\n/g, "\n").trim();
  if (!text.includes('","')) throw new Error("The clipboard does not look like a CSV reply. Copy the chat reply first.");
  if (text.startsWith("BATCH ") || text.startsWith("FIX.")) throw new Error("The clipboard still holds the message you sent. Copy the chat reply.");
  let file = path.join(OUTPUT_DIR, `${slice}.csv`);
  if (fix) {
    let n = 1;
    while (fs.existsSync(path.join(OUTPUT_DIR, `${slice}.fix${n}.csv`))) n++;
    file = path.join(OUTPUT_DIR, `${slice}.fix${n}.csv`);
  }
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${text}\n`);
  console.log(`Saved to output/${path.basename(file)}.`);
  report(slice);
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const [command = "status", arg] = process.argv.slice(2);
  const slices = visitNoteSlices();

  if (command === "next") {
    const from = arg ? slices.findIndex((s) => s.startsWith(arg)) : 0;
    if (from === -1) throw new Error(`No visit-note slice starts with ${arg}.`);
    const next = slices.slice(from).find((s) => !hasOutput(s));
    if (!next) return console.log("Every visit-note slice has output.");
    copySlice(next);
  } else if (command === "copy") {
    if (!arg || !fs.existsSync(path.join(INPUT_DIR, `${arg}.jsonl`))) throw new Error("Usage: copy <slice>, for example copy B12-M03");
    copySlice(arg);
  } else if (command === "save") {
    save(false);
  } else if (command === "savefix") {
    save(true);
  } else if (command === "fix") {
    const slice = currentSlice();
    const fixFile = path.join(OUTPUT_DIR, `${slice}.fix.txt`);
    if (!fs.existsSync(fixFile)) return console.log(`${slice} has no pending fix message.`);
    setClipboard(fs.readFileSync(fixFile, "utf8"));
    console.log(`Copied the fix message for ${slice}. Paste it into the same chat, copy the reply, then run savefix.`);
  } else if (command === "status") {
    const done = slices.filter(hasOutput);
    const ext = slices.filter((s) => Number(s.slice(1, 3)) >= 12);
    const extDone = ext.filter(hasOutput);
    console.log(`Visit-note slices with output: ${done.length}/${slices.length} (extension ${extDone.length}/${ext.length}).`);
    const pending = ext.filter((s) => !hasOutput(s));
    if (pending.length) console.log(`Next extension slice: ${pending[0]}`);
  } else {
    throw new Error(`Unknown command ${command}.`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
