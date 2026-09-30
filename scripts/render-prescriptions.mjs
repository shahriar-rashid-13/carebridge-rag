// Writes prescription content directly from the manifest for prescription slices whose
// output file is empty (or for the slices named on the command line).
//
// Usage (from carebridge-rag/):
//   node scripts/render-prescriptions.mjs              fill every empty prescription slice
//   node scripts/render-prescriptions.mjs B08-M08 ...  (re)write the named slices
//
// Rendered slices are listed in output/script_rendered.json so the merge step can record
// generator_model = "script".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, toCsv } from "./csv.mjs";

const RAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_DIR = path.join(RAG_DIR, "manifest", "llm_input");
const OUTPUT_DIR = path.join(RAG_DIR, "output");
const HEADER = ["doc_id", "group_id", "record_type", "content"];

const CLOSINGS = [
  "Take the medicines exactly as written and do not share them with anyone else.",
  "Bring this prescription to the next visit so the doctor can review the treatment.",
  "Contact the clinic if the symptoms get worse or new symptoms appear before the follow-up.",
  "Keep the medicines in a cool, dry place and finish each course as written.",
];

const sentence = (text) => {
  const trimmed = text.trim().replace(/\.$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
};

function render(row, index) {
  const header = `Prescription | ${row.visit_date} | ${row.doctor_name}, ${row.specialization} | Patient: ${row.patient_name}, ${row.age}, ${row.gender} | Diagnosis: ${row.diagnosis} | Medicines:`;
  const medicines = row.medicines
    .map((m, i) => `${i + 1}) ${m.name} ${m.dosage}, ${m.frequency}, ${m.duration}`)
    .join("; ");
  const advice = row.advice.split(";").map(sentence).join(" ");
  return `${header} ${medicines}. Advice: ${advice} ${CLOSINGS[index % CLOSINGS.length]} Follow-up: ${row.follow_up}.`;
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function main() {
  const requested = process.argv.slice(2);
  const batches = parseCsv(fs.readFileSync(path.join(RAG_DIR, "manifest", "batches.csv"), "utf8"))
    .slice(1)
    .filter((cells) => cells[1] === "prescription")
    .map((cells) => cells[0]);
  const slices = requested.length
    ? requested
    : batches.filter((slice) => {
        const file = path.join(OUTPUT_DIR, `${slice}.csv`);
        return !fs.existsSync(file) || fs.statSync(file).size === 0;
      });

  const logFile = path.join(OUTPUT_DIR, "script_rendered.json");
  const rendered = new Set(fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : []);
  for (const slice of slices) {
    const rows = readJsonl(path.join(INPUT_DIR, `${slice}.jsonl`));
    if (rows.some((r) => r.record_type !== "prescription")) throw new Error(`${slice} is not a prescription slice`);
    const records = rows.map((row, i) => ({ doc_id: row.doc_id, group_id: row.group_id, record_type: row.record_type, content: render(row, i) }));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${slice}.csv`), toCsv(HEADER, records));
    rendered.add(slice);
    console.log(`${slice}: rendered ${records.length} prescriptions`);
  }
  fs.writeFileSync(logFile, `${JSON.stringify([...rendered].sort(), null, 2)}\n`);
}

main();
