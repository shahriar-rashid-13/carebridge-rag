// Builds the deterministic fact manifest for the synthetic RAG corpus (see SPEC.md).
// Usage (from carebridge-rag/): node scripts/generate-manifest.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMORBIDITIES, DAY_NAMES, DIAGNOSES, DOCTORS, END_DATE, GENERAL_FAQ, NAMES, OCCUPATIONS,
  PLACES, PLAN_NOTES, SPECIALIZATIONS, START_DATE,
} from "./catalog.mjs";
import { toCsv } from "./csv.mjs";

const SEED = 20260929;
const RAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(RAG_DIR, "manifest");

const VISITS_PER_SPEC = 225;
const PAIRED_VISITS = 2300;
const UNPAIRED_PLAN = { continue: 250, tests: 60, lifestyle: 50, referral: 40 };
const DIFFICULTY_QUOTA = { confusable: 189, rare_presentation: 216, long: 135 };
const PATIENT_COUNT = 900;
const MAX_VISITS_PER_PATIENT = 8;
const SLICE_SIZE = 50;

// ------------------------------------------------------------------ random

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const randFloat = (lo, hi) => (lo + rand() * (hi - lo)).toFixed(1);
const pick = (items) => items[Math.floor(rand() * items.length)];
const shuffle = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

function assert(condition, message) {
  if (!condition) throw new Error(`Manifest invariant failed: ${message}`);
}

// ------------------------------------------------------------------ dates

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;
const MID_DATE = "2025-11-01";
const parseDate = (iso) => new Date(`${iso}T00:00:00Z`);
const ALL_DATES = [];
for (let t = parseDate(START_DATE).getTime(); t <= parseDate(END_DATE).getTime(); t += DAY_MS) {
  const date = new Date(t);
  ALL_DATES.push({ iso: date.toISOString().slice(0, 10), weekday: WEEKDAYS[date.getUTCDay()] });
}

function ageOn(dob, iso) {
  const birth = parseDate(dob);
  const on = parseDate(iso);
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < birth.getUTCMonth() ||
    (on.getUTCMonth() === birth.getUTCMonth() && on.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

const slotMinutes = (slot) => {
  const [, h, mm, ap] = slot.match(/^(\d{2}):(\d{2}) (AM|PM)$/);
  return ((Number(h) % 12) + (ap === "PM" ? 12 : 0)) * 60 + Number(mm);
};

const joinList = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} and ${items.at(-1)}`;

// ------------------------------------------------------------------ patients

const FEMALE_ONLY_SURNAMES = new Set(["Akter", "Begum", "Sultana", "Khatun"]);

function occupationFor(age) {
  if (age <= 19) return pick(["university student", "garment factory worker", "delivery rider", "shopkeeper", "homemaker"]);
  if (age >= 63) return pick(["retired civil servant", "homemaker", "shopkeeper", "farmer", "tailor", "madrasa teacher"]);
  const pool = OCCUPATIONS.filter(
    (o) => (o !== "university student" || age <= 25) && (o !== "retired civil servant" || age >= 58),
  );
  return pick(pool);
}

function generatePatients() {
  const used = new Set();
  const patients = [];
  for (let i = 1; i <= PATIENT_COUNT; i++) {
    const gender = rand() < 0.5 ? "male" : "female";
    let fullName;
    do {
      const hindu = rand() < 0.1;
      const first = pick(hindu ? NAMES[gender === "male" ? "hinduMale" : "hinduFemale"] : NAMES[gender === "male" ? "muslimMale" : "muslimFemale"]);
      const surnames = hindu
        ? NAMES.hinduSurname
        : NAMES.muslimSurname.filter((s) => gender === "female" || !FEMALE_ONLY_SURNAMES.has(s));
      fullName = `${first} ${pick(surnames)}`;
    } while (used.has(fullName));
    used.add(fullName);

    const ageAtMid = randInt(19, 80);
    const dob = new Date(parseDate(MID_DATE).getTime() - (ageAtMid * 365.25 + randInt(0, 364)) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    patients.push({
      ref: `PAT-${String(i).padStart(6, "0")}`,
      name: fullName,
      gender,
      dob,
      ageAtMid: ageOn(dob, MID_DATE),
      comorbidity: rand() < 0.6 ? "none" : pick(COMORBIDITIES),
      occupation: null,
      weight: randInt(45, 95),
      visitCount: 0,
      dxSet: new Set(),
    });
  }
  for (const p of patients) p.occupation = occupationFor(p.ageAtMid);
  return patients;
}

// ------------------------------------------------------------------ episodes and schedule

function wantedGender(dx) {
  if (dx.sex === "female") return "female";
  if (dx.sex === "female70") return rand() < 0.7 ? "female" : "male";
  if (dx.sex === "female65") return rand() < 0.65 ? "female" : "male";
  return null;
}

function eligiblePatients(patients, dx, visits, gender, allowRepeatDx) {
  return patients.filter(
    (p) =>
      p.ageAtMid >= dx.age[0] + 1 &&
      p.ageAtMid <= dx.age[1] - 1 &&
      (!gender || p.gender === gender) &&
      p.visitCount + visits <= MAX_VISITS_PER_PATIENT &&
      (allowRepeatDx || !p.dxSet.has(dx.id)),
  );
}

function choosePatient(patients, dx, visits) {
  const strict = dx.sex === "female";
  const gender = wantedGender(dx);
  let pool = eligiblePatients(patients, dx, visits, gender, false);
  if (!pool.length && !strict) pool = eligiblePatients(patients, dx, visits, null, false);
  if (!pool.length) pool = eligiblePatients(patients, dx, visits, strict ? "female" : null, true);
  assert(pool.length > 0, `no eligible patient for ${dx.id}`);
  const min = Math.min(...pool.map((p) => p.visitCount));
  const spread = rand() < 0.3 ? 3 : 0;
  return pick(pool.filter((p) => p.visitCount <= min + spread));
}

function buildEpisodes() {
  const episodes = [];
  for (const spec of SPECIALIZATIONS) {
    const dxs = DIAGNOSES.filter((d) => d.spec === spec.name);
    assert(dxs.length === 4, `${spec.name} must have 4 diagnoses`);
    let remaining = VISITS_PER_SPEC;
    let order = [];
    while (remaining > 0) {
      if (!order.length) order = shuffle(dxs);
      const dx = order.pop();
      const n = Math.min(remaining, dx.chronic ? randInt(2, 4) : rand() < 0.15 ? 2 : 1);
      episodes.push({ dx, spec, n });
      remaining -= n;
    }
  }
  const restrictiveness = (dx) => (dx.sex === "female" ? 0 : 1) * 100 + (dx.age[1] - dx.age[0]);
  return shuffle(episodes).sort((a, b) => restrictiveness(a.dx) - restrictiveness(b.dx));
}

function schedule(episodes, patients) {
  const occupied = new Set();
  const patientDates = new Set();
  const visits = [];

  const place = (doctor, targetIdx, patient, minIdx) => {
    for (let step = 0; step <= 80; step++) {
      const offset = step % 2 === 0 ? step / 2 : -(step + 1) / 2;
      const idx = targetIdx + offset;
      if (idx <= minIdx || idx >= ALL_DATES.length) continue;
      const { iso, weekday } = ALL_DATES[idx];
      if (!doctor.days.includes(weekday) || patientDates.has(`${patient.ref}|${iso}`)) continue;
      const free = doctor.slots.filter((s) => !occupied.has(`${doctor.ref}|${iso}|${s}`));
      if (!free.length) continue;
      const slot = pick(free);
      occupied.add(`${doctor.ref}|${iso}|${slot}`);
      patientDates.add(`${patient.ref}|${iso}`);
      return { idx, iso, weekday, slot };
    }
    return null;
  };

  episodes.forEach((episode, episodeIndex) => {
    const { dx, spec, n } = episode;
    const patient = choosePatient(patients, dx, n);
    patient.visitCount += n;
    patient.dxSet.add(dx.id);
    const specDoctors = DOCTORS.filter((d) => d.specialization === spec.name);
    const primary = pick(specDoctors);
    const maxGap = dx.chronic ? 150 : 14;
    let targetIdx = randInt(0, ALL_DATES.length - 1 - maxGap * (n - 1) - 5);
    let minIdx = -1;
    for (let k = 0; k < n; k++) {
      const doctor = k === 0 || rand() < 0.85 ? primary : pick(specDoctors.filter((d) => d !== primary));
      const placed = place(doctor, targetIdx, patient, minIdx);
      assert(placed, `could not schedule ${dx.id} for ${patient.ref}`);
      visits.push({
        patient, doctor, dx, spec, episodeIndex, visitIndex: k,
        visitKind: k === 0 ? "first visit" : "follow-up visit",
        date: placed.iso, weekday: placed.weekday, slot: placed.slot,
        age: ageOn(patient.dob, placed.iso),
      });
      minIdx = placed.idx;
      targetIdx = placed.idx + (dx.chronic ? randInt(30, maxGap) : randInt(5, maxGap));
    }
  });
  return visits;
}

// ------------------------------------------------------------------ plans, numbering, difficulty

function assignPlans(visits) {
  const chosen = new Set();
  const take = (candidates, count, planType) => {
    const picked = shuffle(candidates.filter((v) => !chosen.has(v))).slice(0, count);
    assert(picked.length === count, `not enough candidates for plan ${planType}`);
    for (const v of picked) {
      chosen.add(v);
      v.planType = planType;
    }
  };
  take(visits.filter((v) => v.dx.chronic && v.visitIndex > 0), UNPAIRED_PLAN.continue, "continue");
  const deferrable = visits.filter((v) => v.visitIndex === 0 && v.dx.canDefer);
  take(deferrable, UNPAIRED_PLAN.tests, "tests");
  take(deferrable, UNPAIRED_PLAN.lifestyle, "lifestyle");
  take(deferrable, UNPAIRED_PLAN.referral, "referral");
  for (const v of visits) if (!chosen.has(v)) v.planType = "prescription";
}

function numberVisits(visits) {
  const order = (a, b) =>
    a.date.localeCompare(b.date) || slotMinutes(a.slot) - slotMinutes(b.slot) || a.doctor.ref.localeCompare(b.doctor.ref);
  const paired = visits.filter((v) => v.planType === "prescription").sort(order);
  const unpaired = visits.filter((v) => v.planType !== "prescription").sort(order);
  assert(paired.length === PAIRED_VISITS, `expected ${PAIRED_VISITS} paired visits, got ${paired.length}`);
  [...paired, ...unpaired].forEach((v, i) => {
    const n = String(i + 1).padStart(6, "0");
    v.docId = `VN-${n}`;
    v.groupId = `VISIT-${n}`;
    v.rxDocId = v.planType === "prescription" ? `RX-${n}` : null;
  });
  return [...paired, ...unpaired];
}

function assignDifficulty(visits) {
  const byDx = new Map();
  for (const v of visits) {
    if (!byDx.has(v.dx.id)) byDx.set(v.dx.id, []);
    byDx.get(v.dx.id).push(v);
  }
  let confusable = 0;
  for (const b of shuffle(visits)) {
    if (confusable === DIFFICULTY_QUOTA.confusable) break;
    if (b.difficulty) continue;
    const partner = shuffle(byDx.get(b.dx.id)).find((a) => a !== b && !a.difficulty && a.patient !== b.patient);
    if (!partner) continue;
    b.difficulty = "confusable";
    partner.difficulty = "normal";
    b.confusableWith = partner;
    partner.confusableWith = b;
    confusable++;
  }
  assert(confusable === DIFFICULTY_QUOTA.confusable, "not enough confusable pairs");
  const open = shuffle(visits.filter((v) => !v.difficulty));
  let cursor = 0;
  for (const [difficulty, count] of [["rare_presentation", DIFFICULTY_QUOTA.rare_presentation], ["long", DIFFICULTY_QUOTA.long]]) {
    for (let i = 0; i < count; i++) open[cursor++].difficulty = difficulty;
  }
  for (const v of visits) v.difficulty ??= "normal";
}

// ------------------------------------------------------------------ anchors and vitals

function renderVital([kind, lo, hi, lo2, hi2]) {
  const side = () => pick(["left", "right"]);
  switch (kind) {
    case "temp": return `temperature ${randFloat(lo, hi)}°F`;
    case "bp": return `BP ${randInt(lo, hi)}/${randInt(lo2, hi2)} mmHg`;
    case "spo2": return `SpO2 ${randInt(lo, hi)}%`;
    case "pulse": return `pulse ${randInt(lo, hi)} bpm`;
    case "pulse_irregular": return `pulse ${randInt(lo, hi)} bpm and irregular`;
    case "glucose": return `fasting glucose ${randFloat(lo, hi)} mmol/L`;
    case "glucose_random": return `random blood glucose ${randFloat(lo, hi)} mmol/L`;
    case "hb": return `haemoglobin ${randFloat(lo, hi)} g/dL`;
    case "platelet": return `platelet count ${randInt(lo, hi)}000 per microlitre`;
    case "ldl": return `LDL cholesterol ${randFloat(lo, hi)} mmol/L`;
    case "tsh": return `TSH ${randFloat(lo, hi)} mIU/L`;
    case "vitd": return `vitamin D level ${randInt(lo, hi)} ng/mL`;
    case "bmi": return `BMI ${randFloat(lo, hi)}`;
    case "pain": return `pain score ${randInt(lo, hi)}/10`;
    case "lesion": return `affected area about ${randInt(lo, hi)} cm across`;
    case "spots": return `about ${randInt(lo, hi)} inflamed spots on the face`;
    case "welts": return `about ${randInt(lo, hi)} welts on the trunk and arms`;
    case "abduction": return `shoulder lifts only to ${randInt(lo / 5, hi / 5) * 5} degrees`;
    case "headache_days": return `about ${randInt(lo, hi)} headache days a month`;
    case "monofilament": return `reduced sensation at ${randInt(lo, hi)} of 10 monofilament test sites`;
    case "dix_hallpike": return `Dix-Hallpike test positive on the ${side()} side`;
    case "acuity": return `visual acuity 6/${[6, 9, 12, 18][randInt(lo, hi)]} in the ${side()} eye`;
    case "tbut": return `tear break-up time ${randInt(lo, hi)} seconds`;
    case "lid_lump": return `lump about ${randInt(lo, hi)} mm on the ${side()} upper eyelid`;
    case "sneezes": return `about ${randInt(lo, hi)} sneezing fits a day`;
    case "gad7": return `GAD-7 score ${randInt(lo, hi)}`;
    case "phq9": return `PHQ-9 score ${randInt(lo, hi)}`;
    case "isi": return `Insomnia Severity Index score ${randInt(lo, hi)}`;
    case "attacks": return `about ${randInt(lo, hi)} panic attacks in the last month`;
    default: throw new Error(`unknown vital kind ${kind}`);
  }
}

function otherVitals(v) {
  const kind = v.dx.vital[0];
  const parts = [];
  if (v.dx.febrile && kind !== "temp") parts.push(`temperature ${randFloat(101.0, 103.4)}°F`);
  if (kind !== "bp") {
    parts.push(v.comorbidity === "Essential hypertension"
      ? `BP ${randInt(136, 152)}/${randInt(86, 96)} mmHg`
      : `BP ${randInt(110, 136)}/${randInt(70, 86)} mmHg`);
  }
  if (!kind.startsWith("pulse")) parts.push(`pulse ${v.dx.febrile ? randInt(92, 110) : randInt(68, 92)} bpm`);
  if (v.spec.name === "Pulmonology" && kind !== "spo2") {
    parts.push(`SpO2 ${v.dx.id === "DX-0303" ? randInt(91, 95) : randInt(94, 98)}%`);
  }
  parts.push(`weight ${v.patient.weight + randInt(-2, 2)} kg`);
  return parts.join(", ");
}

const WORK_TRIGGER = /shift|work|office|job|colleague|factory|call centre|employment|deadline|company|hospital|business/i;
const STUDY_TRIGGER = /exam|university|college|hostel/i;
const NON_WORKING = new Set(["retired civil servant", "homemaker", "university student"]);

function triggerFits(trigger, patient) {
  if (WORK_TRIGGER.test(trigger) && NON_WORKING.has(patient.occupation)) return false;
  if (STUDY_TRIGGER.test(trigger) && patient.occupation !== "university student") return false;
  return true;
}

function assignAnchors(visits) {
  const tuples = new Set();
  const assign = (v, context, place) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const vital = renderVital(v.dx.vital);
      const key = `${v.patient.occupation}|${context}|${vital}`;
      if (tuples.has(key)) continue;
      tuples.add(key);
      Object.assign(v, { anchorOccupation: v.patient.occupation, anchorContext: context, anchorPlace: place, anchorVital: vital });
      return;
    }
    throw new Error(`could not find a unique anchor for ${v.docId}`);
  };
  const partners = new Map();
  for (const b of visits.filter((x) => x.difficulty === "confusable")) {
    partners.set(b.confusableWith, [...(partners.get(b.confusableWith) ?? []), b]);
  }
  for (const v of visits.filter((x) => x.difficulty !== "confusable")) {
    const place = pick(PLACES);
    const people = [v, ...(partners.get(v) ?? [])].map((x) => x.patient);
    const fitting = v.dx.triggers.filter((t) => people.every((p) => triggerFits(t, p)));
    const trigger = pick(fitting.length ? fitting : v.dx.triggers.filter((t) => triggerFits(t, v.patient)));
    if (!trigger) throw new Error(`no trigger fits ${v.docId} (${v.patient.occupation}, ${v.dx.name})`);
    assign(v, trigger.replace("{place}", place), place);
  }
  for (const v of visits.filter((x) => x.difficulty === "confusable")) {
    assign(v, v.confusableWith.anchorContext, v.confusableWith.anchorPlace);
  }
}

// ------------------------------------------------------------------ rows

function chiefComplaintHint(dx) {
  return joinList(shuffle(dx.cues).slice(0, randInt(2, Math.min(3, dx.cues.length))));
}

function buildVisitRows(visits) {
  const dxCountByPatient = new Map();
  for (const v of visits) {
    const key = `${v.patient.ref}|${v.dx.id}`;
    dxCountByPatient.set(key, (dxCountByPatient.get(key) ?? 0) + 1);
  }
  return visits.map((v) => {
    v.comorbidity = v.patient.comorbidity === v.dx.name ? "none" : v.patient.comorbidity;
    const referTo = v.planType === "referral" ? pick(v.spec.referTo) : null;
    const planNote =
      v.planType === "continue" ? PLAN_NOTES.continue
        : v.planType === "tests" ? PLAN_NOTES.tests(v.dx)
          : v.planType === "lifestyle" ? PLAN_NOTES.lifestyle
            : v.planType === "referral" ? PLAN_NOTES.referral(referTo)
              : null;
    const followUp =
      v.planType === "tests" ? "after the test results are ready"
        : v.planType === "referral" ? `after the ${referTo} review`
          : v.dx.followUp;
    const regimen = v.planType === "prescription"
      ? v.dx.regimens[v.dx.regimens.length > 1 && rand() < 0.3 ? 1 : 0]
      : null;
    const edgeTags = [];
    if (dxCountByPatient.get(`${v.patient.ref}|${v.dx.id}`) > 1) edgeTags.push("multi_visit");
    if (v.comorbidity !== "none") edgeTags.push("comorbidity");
    if (v.planType === "referral") edgeTags.push("referral");
    if (v.age >= 70) edgeTags.push("elderly");
    const medicineLines = regimen?.map((med, i) => `${i + 1}) ${med.name} ${med.dosage}, ${med.frequency}, ${med.duration}`) ?? [];

    return {
      doc_id: v.docId,
      rx_doc_id: v.rxDocId,
      group_id: v.groupId,
      record_type: "visit_note",
      visit_kind: v.visitKind,
      synthetic_patient_ref: v.patient.ref,
      patient_name: v.patient.name,
      gender: v.patient.gender,
      age: v.age,
      synthetic_doctor_ref: v.doctor.ref,
      doctor_name: v.doctor.name,
      specialization_id: v.spec.id,
      specialization: v.spec.name,
      diagnosis_id: v.dx.id,
      diagnosis: v.dx.name,
      visit_date: v.date,
      weekday: v.weekday,
      time_slot: v.slot,
      chief_complaint_hint: chiefComplaintHint(v.dx),
      anchor_occupation: v.anchorOccupation,
      anchor_context: v.anchorContext,
      anchor_place: v.anchorPlace,
      anchor_vital: v.anchorVital,
      other_vitals: otherVitals(v),
      comorbidity: v.comorbidity,
      has_prescription: v.planType === "prescription",
      plan_type: v.planType,
      plan_note: planNote,
      medicines: regimen,
      medicine_lines: medicineLines,
      advice: v.dx.advice,
      rx_advice: v.dx.rxAdvice,
      follow_up: followUp,
      presentation_hint: v.difficulty === "rare_presentation" ? v.dx.atypical : null,
      must_include: v.dx.mustInclude ?? null,
      difficulty: v.difficulty,
      edge_tags: edgeTags,
      confusable_with: v.confusableWith?.docId ?? null,
      length_words: v.difficulty === "long" ? "350-500" : "120-220",
      answer_facts_vn: [v.patient.name, v.date, v.doctor.name, v.dx.name, v.anchorVital, v.anchorOccupation],
      answer_facts_rx: regimen ? [v.patient.name, v.date, v.dx.name, ...medicineLines.map((l) => l.replace(/^\d+\) /, ""))] : null,
      generator_seed: SEED,
    };
  });
}

function buildFaqRows() {
  const intents = [];
  const add = (topic, questionHint, answerFacts) => intents.push({ topic, questionHint, answerFacts });
  assert(GENERAL_FAQ.length === 70, `expected 70 general FAQ intents, got ${GENERAL_FAQ.length}`);
  for (const [topic, hint, facts] of GENERAL_FAQ) add(topic, hint, facts);

  const doctorNames = (specName) => joinList(DOCTORS.filter((d) => d.specialization === specName).map((d) => d.name));
  const urgent = new Set(["Cardiology", "Neurology", "Pulmonology"]);
  for (const dx of DIAGNOSES) {
    const facts = [dx.spec, doctorNames(dx.spec), "this is general guidance, not medical advice"];
    if (urgent.has(dx.spec)) facts.push("for severe or sudden symptoms call 999");
    add("Symptom routing", `which doctor should I see for ${dx.cues[0]} and ${dx.cues[1]}`, facts);
  }
  for (const d of DOCTORS) {
    add("Doctor schedule", `when is ${d.name} available`, [
      `${d.name} works on ${joinList(d.days.map((day) => DAY_NAMES[day]))}`,
      `appointments from ${d.slots[0]} to ${d.slots.at(-1)}`,
      d.room,
    ]);
  }
  for (const d of DOCTORS) {
    const facts = [`${d.fee} BDT`, "payment is made at reception after the visit", "cash, card, or mobile banking"];
    if (d.senior) facts.push(`${d.name} is a senior consultant`);
    add("Doctor fees", `how much does ${d.name} charge for a consultation`, facts);
  }
  for (const d of DOCTORS) {
    add("Doctor profile", `tell me about ${d.name}`, [
      `specializes in ${d.specialization}`,
      `${d.experienceYears} years of experience`,
      `speaks ${joinList(d.languages.split(", "))}`,
    ]);
  }
  for (const s of SPECIALIZATIONS) {
    add("Specialization doctors", `which doctors work in ${s.name}`, [doctorNames(s.name), "book through Book Appointment in the app"]);
  }
  for (const s of SPECIALIZATIONS) {
    add("Visit preparation", `how should I prepare for a ${s.name} appointment`, [
      "bring photo ID, previous prescriptions, and recent test reports",
      s.prepTip,
    ]);
  }
  assert(intents.length === 250, `expected 250 FAQ intents, got ${intents.length}`);
  return intents.map((intent, i) => {
    const n = i + 1;
    return {
      doc_id: `FAQ-${String(n).padStart(6, "0")}`,
      group_id: null,
      record_type: "faq",
      faq_intent: `FAQI-${String(n).padStart(3, "0")}`,
      faq_topic: intent.topic,
      question_hint: intent.questionHint,
      answer_facts: intent.answerFacts,
      difficulty: "normal",
      length_words: "40-120",
      generator_seed: SEED,
    };
  });
}

// ------------------------------------------------------------------ LLM input slices

const vnInput = (r) => ({
  record_type: "visit_note", doc_id: r.doc_id, group_id: r.group_id, visit_kind: r.visit_kind,
  visit_date: r.visit_date, time_slot: r.time_slot, doctor_name: r.doctor_name, specialization: r.specialization,
  patient_name: r.patient_name, age: r.age, gender: r.gender, chief_complaint_hint: r.chief_complaint_hint,
  anchor_occupation: r.anchor_occupation, anchor_context: r.anchor_context, anchor_vital: r.anchor_vital,
  other_vitals: r.other_vitals, comorbidity: r.comorbidity, diagnosis: r.diagnosis,
  has_prescription: r.has_prescription, plan_note: r.plan_note, advice: r.advice, follow_up: r.follow_up,
  presentation_hint: r.presentation_hint, must_include: r.must_include, length_words: r.length_words,
});

const rxInput = (r) => ({
  record_type: "prescription", doc_id: r.rx_doc_id, group_id: r.group_id, visit_date: r.visit_date,
  doctor_name: r.doctor_name, specialization: r.specialization, patient_name: r.patient_name, age: r.age,
  gender: r.gender, diagnosis: r.diagnosis, medicines: r.medicines, advice: r.rx_advice,
  follow_up: r.follow_up, length_words: "60-120",
});

const faqInput = (r) => ({
  record_type: "faq", doc_id: r.doc_id, group_id: null, faq_intent: r.faq_intent, faq_topic: r.faq_topic,
  question_hint: r.question_hint, answer_facts: r.answer_facts, length_words: r.length_words,
});

function buildSlices(visitRows, faqRows) {
  const vn = visitRows.map(vnInput);
  const rx = visitRows.filter((r) => r.has_prescription).map(rxInput);
  const faq = faqRows.map(faqInput);
  const slices = [];
  const addBatch = (batch, rows, firstMessage) => {
    for (let i = 0; i < rows.length; i += SLICE_SIZE) {
      const message = firstMessage + i / SLICE_SIZE;
      slices.push({ id: `B${String(batch).padStart(2, "0")}-M${String(message).padStart(2, "0")}`, rows: rows.slice(i, i + SLICE_SIZE) });
    }
  };
  for (let b = 1; b <= 5; b++) addBatch(b, vn.slice((b - 1) * 500, b * 500), 1);
  addBatch(6, vn.slice(2500, 2700), 1);
  addBatch(6, rx.slice(0, 300), 5);
  for (let b = 7; b <= 10; b++) addBatch(b, rx.slice(300 + (b - 7) * 500, 300 + (b - 6) * 500), 1);
  addBatch(11, faq, 1);
  return slices;
}

// ------------------------------------------------------------------ main

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function main() {
  const patients = generatePatients();
  const visits = schedule(buildEpisodes(), patients);
  assert(visits.length === VISITS_PER_SPEC * SPECIALIZATIONS.length, `expected 2700 visits, got ${visits.length}`);
  assignPlans(visits);
  const numbered = numberVisits(visits);
  assignDifficulty(numbered);
  assignAnchors(numbered);
  const visitRows = buildVisitRows(numbered);
  const faqRows = buildFaqRows();
  const slices = buildSlices(visitRows, faqRows);

  for (const v of numbered) {
    assert(v.doctor.days.includes(v.weekday), `${v.docId} weekday not in doctor days`);
    assert(v.doctor.slots.includes(v.slot), `${v.docId} slot not in doctor slots`);
    assert(v.age >= v.dx.age[0] && v.age <= v.dx.age[1], `${v.docId} age ${v.age} outside ${v.dx.id} range`);
    assert(v.dx.sex !== "female" || v.patient.gender === "female", `${v.docId} sex rule`);
  }
  const sliceRows = slices.reduce((sum, s) => sum + s.rows.length, 0);
  assert(sliceRows === 5250, `expected 5250 slice rows, got ${sliceRows}`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, "llm_input"), { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, "doctors.csv"), toCsv(
    ["ref", "name", "specialization", "specialization_id", "days", "slots", "fee", "room", "experience_years", "languages"],
    DOCTORS.map((d) => ({ ...d, specialization_id: d.specializationId, days: d.days.join(" "), slots: d.slots.join("; "), experience_years: d.experienceYears })),
  ));
  fs.writeFileSync(path.join(OUT_DIR, "patients.csv"), toCsv(
    ["ref", "name", "gender", "date_of_birth", "comorbidity", "occupation", "visit_count"],
    patients.map((p) => ({ ...p, date_of_birth: p.dob, visit_count: p.visitCount })),
  ));
  writeJsonl(path.join(OUT_DIR, "visits.jsonl"), visitRows);
  writeJsonl(path.join(OUT_DIR, "faq_intents.jsonl"), faqRows);
  for (const slice of slices) writeJsonl(path.join(OUT_DIR, "llm_input", `${slice.id}.jsonl`), slice.rows);
  fs.writeFileSync(path.join(OUT_DIR, "batches.csv"), toCsv(
    ["batch_id", "record_type", "first_doc_id", "last_doc_id", "rows"],
    slices.map((s) => ({ batch_id: s.id, record_type: s.rows[0].record_type, first_doc_id: s.rows[0].doc_id, last_doc_id: s.rows.at(-1).doc_id, rows: s.rows.length })),
  ));

  const countBy = (rows, key) => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {});
  const visitHistogram = countBy(patients, "visitCount");
  const summary = {
    generator_seed: SEED,
    visit_notes: visitRows.length,
    prescriptions: visitRows.filter((r) => r.has_prescription).length,
    faq: faqRows.length,
    total_records: sliceRows,
    slices: slices.length,
    visits_by_specialization: countBy(visitRows, "specialization"),
    visits_by_difficulty: countBy(visitRows, "difficulty"),
    visits_by_plan: countBy(visitRows, "plan_type"),
    patients_with_visits: patients.filter((p) => p.visitCount > 0).length,
    visits_per_patient_histogram: visitHistogram,
    date_range: [visitRows.map((r) => r.visit_date).sort()[0], visitRows.map((r) => r.visit_date).sort().at(-1)],
  };
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

main();
