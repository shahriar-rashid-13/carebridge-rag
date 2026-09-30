// Merges validated LLM/script output with the manifest into the clean corpus.
//
// Usage (from carebridge-rag/): node scripts/build-corpus.mjs
//
// Every slice with output is re-validated first; rows with validator errors are left out.
// Output: corpus/corpus_clean.jsonl (one record per line) and corpus/summary.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.mjs";
import { outputFilesFor, readOutputRows, validateSlice } from "./validate-batch.mjs";

const RAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_DIR = path.join(RAG_DIR, "manifest");
const OUTPUT_DIR = path.join(RAG_DIR, "output");
const CORPUS_DIR = path.join(RAG_DIR, "corpus");

// These topics describe fictional doctors; the app must use the real doctors table instead.
const HIDDEN_FAQ_TOPICS = new Set(["Doctor schedule", "Doctor fees", "Doctor profile", "Specialization doctors"]);

const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

function loadFacts() {
  const facts = new Map();
  for (const v of readJsonl(path.join(MANIFEST_DIR, "visits.jsonl"))) {
    const shared = {
      group_id: v.group_id,
      synthetic_patient_ref: v.synthetic_patient_ref,
      synthetic_doctor_ref: v.synthetic_doctor_ref,
      patient_name: v.patient_name,
      doctor_name: v.doctor_name,
      specialization: v.specialization,
      diagnosis_id: v.diagnosis_id,
      diagnosis: v.diagnosis,
      visit_date: v.visit_date,
      time_slot: v.time_slot,
      visit_kind: v.visit_kind,
      difficulty: v.difficulty,
      edge_tags: v.edge_tags,
      generator_seed: v.generator_seed,
    };
    facts.set(v.doc_id, {
      ...shared,
      record_type: "visit_note",
      medicines: null,
      anchor_occupation: v.anchor_occupation,
      anchor_context: v.anchor_context,
      anchor_vital: v.anchor_vital,
      answer_facts: v.answer_facts_vn,
      confusable_with: v.confusable_with,
    });
    if (v.rx_doc_id) {
      facts.set(v.rx_doc_id, {
        ...shared,
        record_type: "prescription",
        medicines: v.medicines,
        anchor_occupation: null,
        anchor_context: null,
        anchor_vital: null,
        answer_facts: v.answer_facts_rx,
        confusable_with: null,
      });
    }
  }
  for (const f of readJsonl(path.join(MANIFEST_DIR, "faq_intents.jsonl"))) {
    facts.set(f.doc_id, {
      record_type: "faq",
      group_id: null,
      faq_intent: f.faq_intent,
      faq_topic: f.faq_topic,
      answer_facts: f.answer_facts,
      difficulty: f.difficulty,
      edge_tags: [],
      generator_seed: f.generator_seed,
    });
  }
  return facts;
}

function toRecord(docId, content, fact, batchId, generatorModel) {
  const isFaq = fact.record_type === "faq";
  return {
    doc_id: docId,
    record_type: fact.record_type,
    group_id: fact.group_id,
    content,
    synthetic_patient_ref: fact.synthetic_patient_ref ?? null,
    synthetic_doctor_ref: fact.synthetic_doctor_ref ?? null,
    patient_name: fact.patient_name ?? null,
    doctor_name: fact.doctor_name ?? null,
    specialization: fact.specialization ?? null,
    diagnosis_id: fact.diagnosis_id ?? null,
    diagnosis: fact.diagnosis ?? null,
    medicines: fact.medicines ?? null,
    visit_date: fact.visit_date ?? null,
    time_slot: fact.time_slot ?? null,
    visit_kind: fact.visit_kind ?? null,
    faq_intent: fact.faq_intent ?? null,
    faq_topic: fact.faq_topic ?? null,
    anchor_occupation: fact.anchor_occupation ?? null,
    anchor_context: fact.anchor_context ?? null,
    anchor_vital: fact.anchor_vital ?? null,
    answer_facts: fact.answer_facts,
    difficulty: fact.difficulty,
    edge_tags: fact.edge_tags,
    confusable_with: fact.confusable_with ?? null,
    rag_visible: !(isFaq && HIDDEN_FAQ_TOPICS.has(fact.faq_topic)),
    is_noise: false,
    noise_type: null,
    source_doc_id: null,
    batch_id: batchId,
    generator_model: generatorModel,
    generator_seed: fact.generator_seed,
  };
}

function main() {
  const facts = loadFacts();
  const slices = parseCsv(fs.readFileSync(path.join(MANIFEST_DIR, "batches.csv"), "utf8"))
    .slice(1)
    .filter((cells) => cells.length >= 5)
    .map((cells) => cells[0]);
  const renderedFile = path.join(OUTPUT_DIR, "script_rendered.json");
  const scriptRendered = new Set(fs.existsSync(renderedFile) ? JSON.parse(fs.readFileSync(renderedFile, "utf8")) : []);

  const records = [];
  const excluded = [];
  const skippedSlices = [];
  for (const slice of slices) {
    const files = outputFilesFor(slice).filter((f) => fs.statSync(f).size > 0);
    if (files.length === 0) {
      skippedSlices.push(slice);
      continue;
    }
    const report = validateSlice(slice);
    const failed = new Set(report.results.filter((r) => r.errors.length).map((r) => r.doc_id));
    const rows = new Map();
    for (const file of files) for (const row of readOutputRows(file, [])) rows.set(row.doc_id, row);

    const model = scriptRendered.has(slice) ? "script" : "llm";
    for (const [docId, row] of rows) {
      const fact = facts.get(docId);
      if (!fact || failed.has(docId)) {
        excluded.push({ doc_id: docId, slice, reason: fact ? "validator errors" : "not in manifest" });
        continue;
      }
      records.push(toRecord(docId, row.content, fact, slice, model));
    }
    for (const docId of failed) if (!rows.has(docId)) excluded.push({ doc_id: docId, slice, reason: "missing" });
  }

  records.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  const count = (key) => records.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {});
  const summary = {
    total_records: records.length,
    by_record_type: count("record_type"),
    by_generator: count("generator_model"),
    rag_visible: records.filter((r) => r.rag_visible).length,
    hidden_doctor_faq: records.filter((r) => !r.rag_visible).length,
    by_specialization: count("specialization"),
    excluded_count: excluded.length,
    excluded,
    skipped_slices: skippedSlices,
  };

  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CORPUS_DIR, "corpus_clean.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  fs.writeFileSync(path.join(CORPUS_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const { excluded: _omit, ...printable } = summary;
  console.log(JSON.stringify(printable, null, 2));
}

main();
