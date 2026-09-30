// Validates LLM-written CSV output against the manifest slice it was generated from.
//
// Usage (from carebridge-rag/):
//   node scripts/validate-batch.mjs B01-M01      validate one slice
//   node scripts/validate-batch.mjs              validate every slice that has output
//
// Input:  output/<slice>.csv plus optional output/<slice>.fix1.csv, .fix2.csv, ...
//         (rows in later fix files replace rows with the same doc_id)
// Output: output/<slice>.report.json and, when rows fail, output/<slice>.fix.txt
// Exit code 1 when any slice has errors.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.mjs";
import { MEDICINE_NAMES, PLACES } from "./catalog.mjs";

const RAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_DIR = path.join(RAG_DIR, "manifest", "llm_input");
const OUTPUT_DIR = path.join(RAG_DIR, "output");

const HEADER = ["doc_id", "group_id", "record_type", "content"];
const ID_PATTERN = /\b(PAT|DOC|VN|RX|VISIT|FAQI?|DX)-\d/;
// Same-diagnosis notes share advice, follow-up, and exam wording by design; only flag near copies.
const NEAR_DUPLICATE_JACCARD = 0.9;
// Prescriptions are mostly fixed structure, so identical regimens legitimately overlap.
const NEAR_DUPLICATE_TYPES = new Set(["visit_note", "faq"]);
const STOPWORDS = new Set(
  "the and for with from that this have has had was were are his her their them they she him you your our into over after before about when while since than then also only each every been being will would should could there which what where who whom does did done more most some such very just onto upon near".split(" "),
);

// ------------------------------------------------------------------ text helpers

const words = (text) => text.split(/\s+/).filter(Boolean);
const normalize = (text) => text.toLowerCase().replace(/°/g, "").replace(/[^a-z0-9./%-]+/g, " ");
const stem = (word) => word.replace(/(ing|ed|es|s)$/, "").slice(0, 6);
const contentWords = (text) =>
  normalize(text)
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !/^\d/.test(w));
const numbers = (text) => text.match(/\d+(?:[.,/]\d+)*/g) ?? [];
const includesCi = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text, term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(text);

function coverage(source, target) {
  const wanted = [...new Set(contentWords(source).map(stem))];
  if (wanted.length === 0) return 1;
  const have = new Set(contentWords(target).map(stem));
  return wanted.filter((w) => have.has(w)).length / wanted.length;
}

// Repeat visits of one patient legitimately reuse wording; date and anchor_vital still separate them.
const patientOf = (content) => content.match(/\| Patient: ([^,|]+),/)?.[1] ?? null;

function jaccard(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function lengthBounds(range) {
  const [lo, hi] = range.split("-").map(Number);
  // Short text is accepted down to half the minimum; long notes may fall back to normal length.
  return { lo, hi, errorLo: Math.min(Math.floor(lo * 0.5), 90), errorHi: Math.ceil(hi * 1.3) };
}

// ------------------------------------------------------------------ loading

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function readOutputRows(file, problems) {
  const text = fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```") && line.trim() !== "CONTINUE")
    .join("\n");
  const rows = [];
  for (const cells of parseCsv(text)) {
    if (cells.length === 1 && cells[0].trim() === "") continue;
    if (cells[0] === "doc_id") continue;
    if (cells.length !== HEADER.length) {
      problems.push(`${path.basename(file)}: malformed CSV line starting "${cells.join(",").slice(0, 60)}" (${cells.length} fields, expected 4; check for double quotes inside content)`);
      continue;
    }
    rows.push(Object.fromEntries(HEADER.map((key, i) => [key, cells[i]])));
  }
  return rows;
}

export function outputFilesFor(slice) {
  const base = path.join(OUTPUT_DIR, `${slice}.csv`);
  if (!fs.existsSync(base)) return [];
  const fixes = fs
    .readdirSync(OUTPUT_DIR)
    .filter((name) => new RegExp(`^${escapeRegex(slice)}\\.fix\\d+\\.csv$`).test(name))
    .sort((a, b) => Number(a.match(/fix(\d+)/)[1]) - Number(b.match(/fix(\d+)/)[1]))
    .map((name) => path.join(OUTPUT_DIR, name));
  return [base, ...fixes];
}

// ------------------------------------------------------------------ per-type checks

function checkCommon(row, out, errors) {
  const expectedGroup = row.group_id ?? "";
  if (out.group_id !== expectedGroup) errors.push(`group_id is "${out.group_id}", expected "${expectedGroup}"`);
  if (out.record_type !== row.record_type) errors.push(`record_type is "${out.record_type}", expected "${row.record_type}"`);
  if (/[\r\n]/.test(out.content)) errors.push("content contains a line break");
  if (out.content.includes('"')) errors.push("content contains a double quote");
  const id = out.content.match(ID_PATTERN);
  if (id) errors.push(`content contains an ID ("${id[0]}...")`);
}

function checkLength(content, range, errors, warnings) {
  const count = words(content).length;
  const { lo, hi, errorLo, errorHi } = lengthBounds(range);
  if (count < errorLo || count > errorHi) errors.push(`length is ${count} words, expected ${range}`);
  else if (count < lo || count > hi) warnings.push(`length is ${count} words, target ${range}`);
}

function unexpectedMedicines(content, allowed, exemptText) {
  let remaining = content;
  for (const name of allowed) remaining = remaining.replace(new RegExp(escapeRegex(name), "gi"), " ");
  return MEDICINE_NAMES.filter((name) => mentions(remaining, name) && !mentions(exemptText, name));
}

function checkVisitNote(row, content, errors, warnings) {
  const header = `Visit note | ${row.visit_date} ${row.time_slot} | ${row.doctor_name}, ${row.specialization} | Patient: ${row.patient_name}, ${row.age}, ${row.gender}.`;
  if (!content.startsWith(header)) errors.push(`header must be exactly: ${header}`);

  const assessment = content.indexOf("Assessment:");
  if (assessment < 0) errors.push('missing "Assessment:"');
  else if (!includesCi(content.slice(assessment, assessment + 200), row.diagnosis)) {
    errors.push(`"Assessment:" must name the diagnosis "${row.diagnosis}"`);
  }

  if (!content.includes(row.anchor_vital)) {
    const vitalNumbers = numbers(row.anchor_vital);
    if (vitalNumbers.length && vitalNumbers.every((n) => content.includes(n))) warnings.push(`anchor_vital reworded: "${row.anchor_vital}"`);
    else errors.push(`missing anchor_vital exactly as given: "${row.anchor_vital}"`);
  }
  if (!includesCi(content, row.anchor_occupation)) errors.push(`missing occupation "${row.anchor_occupation}"`);
  const place = PLACES.find((p) => row.anchor_context.includes(p));
  if (place && !content.includes(place)) errors.push(`missing place "${place}" from anchor_context`);
  const contextCoverage = coverage(row.anchor_context, content);
  if (contextCoverage < 0.6) errors.push(`anchor_context not reflected (${Math.round(contextCoverage * 100)}% of its words): "${row.anchor_context}"`);

  for (const vital of row.other_vitals.split(/,\s*/)) {
    if (!includesCi(content, vital)) warnings.push(`other vital not found exactly: "${vital}"`);
  }
  if (row.comorbidity && row.comorbidity !== "none" && !includesCi(content, row.comorbidity)) {
    errors.push(`missing comorbidity "${row.comorbidity}"`);
  }

  const exempt = [row.advice, row.plan_note, row.must_include].filter(Boolean).join(" ");
  const named = unexpectedMedicines(content, [], exempt);
  if (named.length) errors.push(`visit note must not name medicines: ${named.join(", ")}`);

  if (row.has_prescription) {
    if (!/prescription/i.test(content)) errors.push("must state that a prescription was issued");
  } else {
    if (!/no new (medicine|medication|prescription)/i.test(content)) errors.push('must state that no new medicine was prescribed (e.g. "no new medicine was prescribed")');
  }

  if (row.must_include) {
    const missingNumbers = numbers(row.must_include).filter((n) => !content.includes(n));
    const mustCoverage = coverage(row.must_include, content);
    if (missingNumbers.length || mustCoverage < 0.7) errors.push(`must include the statement: "${row.must_include}"`);
  }

  const missingFollowUp = numbers(row.follow_up).filter((n) => !content.includes(n));
  if (missingFollowUp.length || coverage(row.follow_up, content) < 0.5) warnings.push(`follow-up not clearly stated: "${row.follow_up}"`);
  if (coverage(row.advice, content) < 0.5) warnings.push("advice poorly reflected");
  if (includesCi(content, row.chief_complaint_hint)) warnings.push("chief_complaint_hint copied word for word");
  const complaintSentence = content.slice(header.length).split(/(?<=[.!?])\s/)[0] ?? "";
  if (includesCi(complaintSentence, row.specialization)) warnings.push("specialization named in the chief complaint sentence");

  checkLength(content, row.length_words, errors, warnings);
}

function checkPrescription(row, content, errors, warnings) {
  const header = `Prescription | ${row.visit_date} | ${row.doctor_name}, ${row.specialization} | Patient: ${row.patient_name}, ${row.age}, ${row.gender} | Diagnosis: ${row.diagnosis} | Medicines:`;
  if (!content.startsWith(header)) errors.push(`header must be exactly: ${header}`);

  row.medicines.forEach((m, i) => {
    const line = `${i + 1}) ${m.name} ${m.dosage}, ${m.frequency}, ${m.duration}`;
    if (!content.includes(line)) errors.push(`medicine line must be exactly: "${line}"`);
  });
  if (new RegExp(`\\b${row.medicines.length + 1}\\)`).test(content)) errors.push(`more than ${row.medicines.length} medicines listed`);
  const extra = unexpectedMedicines(content, row.medicines.map((m) => m.name), row.advice);
  if (extra.length) errors.push(`medicines not in the row: ${extra.join(", ")}`);

  if (!content.includes("Advice:")) errors.push('missing "Advice:"');
  if (!content.includes(`Follow-up: ${row.follow_up}`)) errors.push(`must contain exactly: "Follow-up: ${row.follow_up}"`);
  else if (content.indexOf("Advice:") > content.indexOf("Follow-up:")) errors.push('"Advice:" must come before "Follow-up:"');
  if (coverage(row.advice, content) < 0.5) warnings.push("advice poorly reflected");

  checkLength(content, row.length_words, errors, warnings);
}

function checkFaq(row, content, errors, warnings) {
  const match = content.match(/^Q: (.+?) A: (.+)$/);
  if (!match) {
    errors.push('content must be "Q: <question> A: <answer>"');
    return;
  }
  const answer = match[2];
  for (const fact of row.answer_facts) {
    const missingNumbers = numbers(fact).filter((n) => !answer.includes(n));
    const names = (fact.match(/\b[A-Z][A-Za-z]*(?:\.)?/g) ?? []).filter((w) => !["I", "A"].includes(w));
    const missingNames = names.filter((n) => !answer.includes(n.replace(/\.$/, "")));
    const factCoverage = coverage(fact, answer);
    if (missingNumbers.length || missingNames.length || factCoverage < 0.5) {
      const detail = [...missingNumbers, ...missingNames].join(", ");
      errors.push(`answer misses fact "${fact}"${detail ? ` (missing: ${detail})` : ""}`);
    }
  }
  if (coverage(row.question_hint, match[1]) < 0.3) warnings.push("question drifts from question_hint");
  checkLength(content, row.length_words, errors, warnings);
}

const CHECKS = { visit_note: checkVisitNote, prescription: checkPrescription, faq: checkFaq };

// ------------------------------------------------------------------ slice validation

function loadOtherContent(skipSlice) {
  const others = [];
  if (!fs.existsSync(OUTPUT_DIR)) return others;
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    const match = name.match(/^(B\d+-M\d+)\.csv$/);
    if (!match || match[1] === skipSlice || fs.statSync(path.join(OUTPUT_DIR, name)).size === 0) continue;
    const rows = new Map();
    for (const file of outputFilesFor(match[1])) for (const r of readOutputRows(file, [])) rows.set(r.doc_id, r);
    for (const r of rows.values()) {
      others.push({ docId: r.doc_id, type: r.record_type, patient: patientOf(r.content), words: new Set(contentWords(r.content)) });
    }
  }
  return others;
}

export function validateSlice(slice) {
  const inputFile = path.join(INPUT_DIR, `${slice}.jsonl`);
  if (!fs.existsSync(inputFile)) throw new Error(`unknown slice ${slice}: ${inputFile} not found`);
  const files = outputFilesFor(slice);
  if (files.length === 0) throw new Error(`no output for ${slice}: expected ${path.join(OUTPUT_DIR, `${slice}.csv`)}`);

  const manifest = readJsonl(inputFile);
  const fileProblems = [];
  const outputs = new Map();
  const duplicates = new Set();
  for (const file of files) {
    const seenInFile = new Set();
    for (const r of readOutputRows(file, fileProblems)) {
      if (seenInFile.has(r.doc_id)) duplicates.add(r.doc_id);
      seenInFile.add(r.doc_id);
      outputs.set(r.doc_id, r);
    }
  }

  // A cut-off line is harmless once a later fix file supplies that doc_id.
  const unresolvedProblems = fileProblems.filter((p) => !/"(\w+-\d+),/.test(p) || !outputs.has(p.match(/"(\w+-\d+),/)[1]));
  fileProblems.length = 0;
  fileProblems.push(...unresolvedProblems);

  const expectedIds = new Set(manifest.map((r) => r.doc_id));
  const extra = [...outputs.keys()].filter((id) => !expectedIds.has(id));
  const others = loadOtherContent(slice);
  const sliceWords = new Map();

  const results = manifest.map((row) => {
    const out = outputs.get(row.doc_id);
    const errors = [];
    const warnings = [];
    if (!out) {
      errors.push("row missing from output");
      return { doc_id: row.doc_id, errors, warnings };
    }
    if (duplicates.has(row.doc_id)) warnings.push("doc_id appeared more than once; last copy used");
    checkCommon(row, out, errors);
    CHECKS[row.record_type](row, out.content, errors, warnings);

    if (NEAR_DUPLICATE_TYPES.has(row.record_type)) {
      const own = new Set(contentWords(out.content));
      const patient = patientOf(out.content);
      const pool = [...others, ...sliceWords.values()];
      const twin = pool.find(
        (o) =>
          o.type === row.record_type &&
          !(patient && o.patient === patient) &&
          jaccard(own, o.words) >= NEAR_DUPLICATE_JACCARD,
      );
      if (twin) errors.push(`near-duplicate of ${twin.docId}; rewrite with different wording`);
      sliceWords.set(row.doc_id, { docId: row.doc_id, type: row.record_type, patient, words: own });
    }

    return { doc_id: row.doc_id, errors, warnings };
  });

  const failed = results.filter((r) => r.errors.length);
  const report = {
    slice,
    files: files.map((f) => path.basename(f)),
    rows_expected: manifest.length,
    rows_found: manifest.length - results.filter((r) => r.errors.includes("row missing from output")).length,
    rows_passed: manifest.length - failed.length,
    rows_failed: failed.length,
    rows_with_warnings: results.filter((r) => r.warnings.length).length,
    file_problems: fileProblems,
    extra_doc_ids: extra,
    results: results.filter((r) => r.errors.length || r.warnings.length),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, `${slice}.report.json`), `${JSON.stringify(report, null, 2)}\n`);

  const fixFile = path.join(OUTPUT_DIR, `${slice}.fix.txt`);
  if (failed.length) {
    const byId = new Map(manifest.map((r) => [r.doc_id, r]));
    const missingOnly = failed.every((r) => r.errors.length === 1 && r.errors[0] === "row missing from output");
    const lines = [
      missingOnly
        ? `These rows are missing. Write them now and return CSV with the header, same order.`
        : `FIX. Rewrite only these rows and return CSV with the header. Problems:`,
      ...(missingOnly ? [] : failed.map((r) => `- ${r.doc_id}: ${r.errors.join("; ")}`)),
      "",
      ...failed.map((r) => JSON.stringify(byId.get(r.doc_id))),
    ];
    fs.writeFileSync(fixFile, `${lines.join("\n")}\n`);
  } else if (fs.existsSync(fixFile)) {
    fs.unlinkSync(fixFile);
  }
  return report;
}

// ------------------------------------------------------------------ main

function main() {
  const requested = process.argv.slice(2);
  const slices = requested.length
    ? requested
    : fs.existsSync(OUTPUT_DIR)
      ? fs
          .readdirSync(OUTPUT_DIR)
          .filter((n) => fs.statSync(path.join(OUTPUT_DIR, n)).size > 0)
          .map((n) => n.match(/^(B\d+-M\d+)\.csv$/)?.[1])
          .filter(Boolean)
          .sort()
      : [];
  if (slices.length === 0) {
    console.log(`No output files found in ${OUTPUT_DIR}. Save replies as <slice>.csv, for example B01-M01.csv.`);
    return;
  }

  let anyErrors = false;
  for (const slice of slices) {
    const report = validateSlice(slice);
    const ok = report.rows_failed === 0 && report.file_problems.length === 0 && report.extra_doc_ids.length === 0;
    anyErrors ||= !ok;
    console.log(
      `${slice}: ${report.rows_passed}/${report.rows_expected} passed, ${report.rows_failed} failed, ${report.rows_with_warnings} with warnings` +
        (report.file_problems.length ? `, ${report.file_problems.length} malformed lines` : "") +
        (report.extra_doc_ids.length ? `, extra doc_ids: ${report.extra_doc_ids.join(" ")}` : "") +
        (report.rows_failed ? ` -> send output/${slice}.fix.txt, save reply as ${slice}.fix<N>.csv` : ""),
    );
    for (const p of report.file_problems) console.log(`  ${p}`);
  }
  process.exitCode = anyErrors ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
