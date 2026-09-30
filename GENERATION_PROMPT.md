# CareBridge RAG — LLM Generation Prompt

How to use:

1. Generate the manifest once, from `carebridge-rag/`: `node scripts/generate-manifest.mjs`.
2. Open a new ChatGPT (or DeepSeek) conversation per batch (`B01`, `B02`, ...).
3. Paste the **Setup prompt** below once. The model must reply `READY`.
4. For each slice, paste the **Batch message** template with the rows of
   `manifest/llm_input/<slice>.jsonl` (for example `B01-M03.jsonl`).
5. If the reply stops early, send `CONTINUE` and append the new lines to the same file.
6. Save the CSV reply as `output/<slice>.csv` and run
   `node scripts/validate-batch.mjs <slice>`.
7. If rows fail, paste the generated `output/<slice>.fix.txt` into the same conversation. Save the
   reply as `output/<slice>.fix1.csv` (then `fix2`, ...) and validate again.

The manifest rows come from the generator script (see `SPEC.md`). The LLM never invents facts.

---

## Setup prompt (paste once per conversation)

````text
You are a medical-records writer for a synthetic dataset. All people, doctors, and records are fictional. The data is used to test a search system for a clinic app called CareBridge Clinic in Dhaka, Bangladesh.

YOUR TASK
I will send you manifest rows in JSON Lines format. Each row holds all the facts for one record. You write the natural-language text (the "content") for each row and return CSV. You never invent facts that change the record: names, ages, dates, times, doctors, diagnoses, medicines, doses, vitals, and anchors come only from the row.

RECORD TYPES
- visit_note: a doctor's note for one completed clinic visit.
- prescription: the prescription written at the end of that visit.
- faq: a clinic FAQ entry, one question and one answer.

OUTPUT FORMAT (strict)
- Return one CSV code block and nothing else. No explanations before or after.
- First line is the header exactly: doc_id,group_id,record_type,content
- Then one line per input row, in the same order as the input.
- Wrap every field in double quotes. Example: "VN-000123","VISIT-000123","visit_note","Visit note | ..."
- group_id is copied from the row. If group_id is null, write "".
- content is ONE line. No line breaks. Never use the double-quote character inside content; use single quotes if needed.
- Never write any ID (PAT-, DOC-, VN-, RX-, VISIT-, FAQ-, FAQI-, DX-) inside content.
- Return exactly as many data lines as input rows. Do not skip, merge, or add rows.
- If you run out of space, stop after the last complete line and close the code block. I will reply CONTINUE and you resume with the next row, without repeating the header.

RULES FOR visit_note
- Start content with exactly: Visit note | <visit_date> <time_slot> | <doctor_name>, <specialization> | Patient: <patient_name>, <age>, <gender>.
- Then write clinical prose in this order: chief complaint in the patient's own words (paraphrase chief_complaint_hint, do not copy it word for word), history, occupation and context, comorbidity if not "none", relevant negatives, examination, assessment, plan, follow-up.
- Include anchor_occupation, anchor_context, and anchor_vital. Write anchor_vital exactly as given. Include other_vitals.
- Name the diagnosis exactly as given, in a sentence starting with Assessment:
- If has_prescription is true: write that a prescription was issued. Do NOT name any medicine or dose in the visit note.
- If has_prescription is false: use plan_note and state that no new medicine was prescribed. Do NOT name any medicine.
- Use advice and follow_up from the row. Do not add new tests, medicines, or diagnoses.
- If presentation_hint is present, describe the symptoms as that hint says (atypical presentation).
- visit_kind is "first visit" or "follow-up visit". For a follow-up visit, write it as a review of an existing problem.
- If must_include is present, include that statement in substance, keeping any numbers exactly.
- Write other_vitals exactly as given too (for example "BP 132/78 mmHg", not "blood pressure 132 over 78").
- Never write the specialization name inside the chief complaint sentence.
- Length: follow length_words (normal 120-220 words, long 350-500 words).
- Vary sentence structure between records. Do not start every note body with the same phrase.

RULES FOR prescription
- Start content with exactly: Prescription | <visit_date> | <doctor_name>, <specialization> | Patient: <patient_name>, <age>, <gender> | Diagnosis: <diagnosis> | Medicines:
- Then list every medicine in order, exactly as given: 1) <name> <dosage>, <frequency>, <duration>; 2) ...
- End the list with a full stop.
- Then write Advice: followed by 1-3 natural sentences that paraphrase the advice field only.
- Then write Follow-up: <follow_up>.
- Never add, remove, rename, or change any medicine, dosage, frequency, or duration.
- Length: 60-120 words.

RULES FOR faq
- Content format: Q: <question> A: <answer>
- Write the question in a patient's natural voice, paraphrasing question_hint.
- The answer must include every item in answer_facts, with the same numbers and names.
- Add no other facts. No medical advice beyond what answer_facts says.
- Length: follow length_words (40-120 words).

STYLE
- Plain professional English. Bangladeshi context is fine (Dhaka areas, local jobs, local food).
- Temperatures in °F, blood pressure in mmHg, glucose in mmol/L, weight in kg, money in BDT.
- No markdown inside content. No emojis.

EXAMPLE INPUT
{"record_type":"visit_note","doc_id":"VN-000123","group_id":"VISIT-000123","visit_kind":"first visit","visit_date":"2026-03-12","time_slot":"03:30 PM","doctor_name":"Dr. Sabrina Chowdhury","specialization":"Cardiology","patient_name":"Abdul Karim Mia","age":58,"gender":"male","chief_complaint_hint":"chest tightness when walking fast or climbing, eases with rest within minutes","anchor_occupation":"retired civil servant","anchor_context":"first noticed while climbing to his fourth-floor flat in Mirpur","anchor_vital":"BP 148/92 mmHg","other_vitals":"pulse 84 bpm, SpO2 97%, weight 76 kg","comorbidity":"Type 2 diabetes mellitus","diagnosis":"Stable angina","has_prescription":true,"plan_note":null,"advice":"avoid heavy exertion until review; walk 20 minutes daily on flat ground; stop smoking","follow_up":"2 weeks with ECG and fasting lipid profile","presentation_hint":null,"must_include":null,"length_words":"120-220"}
{"record_type":"prescription","doc_id":"RX-000123","group_id":"VISIT-000123","visit_date":"2026-03-12","doctor_name":"Dr. Sabrina Chowdhury","specialization":"Cardiology","patient_name":"Abdul Karim Mia","age":58,"gender":"male","diagnosis":"Stable angina","medicines":[{"name":"Aspirin","dosage":"75 mg","frequency":"Once daily","duration":"Ongoing"},{"name":"Atorvastatin","dosage":"20 mg","frequency":"At bedtime","duration":"Ongoing"},{"name":"Glyceryl trinitrate spray","dosage":"1 puff","frequency":"As needed","duration":"Ongoing"}],"advice":"take aspirin after breakfast; use the spray under the tongue at the start of chest tightness and sit down; if pain lasts more than 15 minutes call 999; stop smoking","follow_up":"2 weeks with ECG and fasting lipid profile","length_words":"60-120"}
{"record_type":"visit_note","doc_id":"VN-002315","group_id":"VISIT-002315","visit_kind":"follow-up visit","visit_date":"2025-11-17","time_slot":"10:30 AM","doctor_name":"Dr. Rumana Haque","specialization":"Endocrinology","patient_name":"Shahana Parvin","age":49,"gender":"female","chief_complaint_hint":"more thirsty and passing urine more often over the past month","anchor_occupation":"schoolteacher","anchor_context":"sugar readings rose during the exam-marking season at her school in Narayanganj","anchor_vital":"fasting glucose 8.4 mmol/L","other_vitals":"BP 128/82 mmHg, pulse 78 bpm, weight 68 kg","comorbidity":"none","diagnosis":"Type 2 diabetes mellitus","has_prescription":false,"plan_note":"chronic follow-up: continue current medicines, no new prescription issued","advice":"reduce rice portions at dinner; brisk walk 30 minutes five days a week; check fasting sugar twice weekly","follow_up":"3 months with HbA1c","presentation_hint":null,"must_include":null,"length_words":"120-220"}
{"record_type":"faq","doc_id":"FAQ-000032","group_id":null,"faq_intent":"FAQI-032","faq_topic":"Waitlist","question_hint":"how long do I have to accept a waitlist offer","answer_facts":["120 minutes","accept the offer in My Appointments","the offer expires if not accepted in time","the slot then passes to the next patient on the waitlist"],"length_words":"40-120"}
{"record_type":"faq","doc_id":"FAQ-000099","group_id":null,"faq_intent":"FAQI-099","faq_topic":"Symptom routing","question_hint":"which doctor should I see for one-sided throbbing headaches with light sensitivity and nausea","answer_facts":["Neurology","Dr. Selina Parvin, Dr. Rezaul Karim, and Dr. Moinul Haque","this is general guidance, not medical advice","for a sudden severe headache, weakness, or confusion call 999"],"length_words":"40-120"}

EXAMPLE OUTPUT
```csv
doc_id,group_id,record_type,content
"VN-000123","VISIT-000123","visit_note","Visit note | 2026-03-12 03:30 PM | Dr. Sabrina Chowdhury, Cardiology | Patient: Abdul Karim Mia, 58, male. Mr. Karim says his chest feels tight and heavy whenever he walks fast, and the feeling settles within a few minutes of resting. He first noticed it while climbing to his fourth-floor flat in Mirpur about six weeks ago. He is a retired civil servant, lives with his wife, and has smoked about five cigarettes a day for thirty years. He has Type 2 diabetes mellitus. He denies pain at rest, fainting, or breathlessness at night. On examination: BP 148/92 mmHg, pulse 84 bpm and regular, SpO2 97%, weight 76 kg. Heart sounds are normal and the chest is clear. Assessment: Stable angina. Plan: a prescription was issued. He was advised to avoid heavy exertion until review, walk 20 minutes daily on flat ground, and stop smoking. Follow-up in 2 weeks with ECG and fasting lipid profile."
"RX-000123","VISIT-000123","prescription","Prescription | 2026-03-12 | Dr. Sabrina Chowdhury, Cardiology | Patient: Abdul Karim Mia, 58, male | Diagnosis: Stable angina | Medicines: 1) Aspirin 75 mg, Once daily, Ongoing; 2) Atorvastatin 20 mg, At bedtime, Ongoing; 3) Glyceryl trinitrate spray 1 puff, As needed, Ongoing. Advice: Take the aspirin after breakfast. At the first sign of chest tightness, sit down and use the spray under the tongue; if the pain lasts more than 15 minutes, call 999. Stop smoking. Follow-up: 2 weeks with ECG and fasting lipid profile."
"VN-002315","VISIT-002315","visit_note","Visit note | 2025-11-17 10:30 AM | Dr. Rumana Haque, Endocrinology | Patient: Shahana Parvin, 49, female. Mrs. Parvin attends for review and says she has felt thirstier than usual and has been passing urine more often over the past month. She is a schoolteacher and noticed her sugar readings rose during the exam-marking season at her school in Narayanganj, when she ate late and skipped her walks. She reports taking her current medicines regularly and has no foot pain, blurred vision, or low-sugar episodes. On examination: fasting glucose 8.4 mmol/L, BP 128/82 mmHg, pulse 78 bpm, weight 68 kg. Sensation in both feet is normal. Assessment: Type 2 diabetes mellitus. Plan: continue current medicines; no new medicine was prescribed and no new prescription was issued today. She was advised to reduce rice portions at dinner, walk briskly for 30 minutes five days a week, and check her fasting sugar twice weekly. Follow-up in 3 months with HbA1c."
"FAQ-000032","","faq","Q: I got a waitlist offer for an earlier slot. How long do I have to accept it? A: You have 120 minutes to accept a waitlist offer. Open My Appointments in the CareBridge app and accept the offer there. If you do not accept it in time, the offer expires and the slot then passes to the next patient on the waitlist."
"FAQ-000099","","faq","Q: I keep getting throbbing headaches on one side of my head, and bright light and nausea make it worse. Which doctor should I book? A: These symptoms are usually seen by our Neurology team. You can book Dr. Selina Parvin, Dr. Rezaul Karim, or Dr. Moinul Haque in the app. This is general guidance, not medical advice; the doctor will assess you at the visit. For a sudden severe headache, weakness, or confusion, call 999."
```

If you understand, reply only with: READY
````

---

## Batch message (paste for each 50-row slice)

````text
BATCH <batch_id> (for example B01-M03). <N> rows. Return CSV only, same order, header first.

<paste 50 JSON Lines rows here>
````

## Continue message

````text
CONTINUE
````

## Fix message (after validator rejects rows)

The validator writes this message for you in `output/<slice>.fix.txt`. The shape is:

````text
FIX. Rewrite only these rows and return CSV with the header. Problems:
- <doc_id>: <validator reason, e.g. missing anchor_vital "SpO2 93%">
- <doc_id>: <validator reason, e.g. visit note names a medicine>

<paste the same manifest rows for those doc_ids>
````

---

## Notes

- 50 visit notes of about 170 words is about 12,000 output tokens. Some chat UIs cut replies earlier.
  If replies often stop early, use 25 rows per message for visit notes; prescriptions and FAQ can stay at 50.
- Start each batch in a fresh conversation. Long conversations drift in style and rule-following.
- Record the model name used for each batch (`generator_model` in `SPEC.md`).
