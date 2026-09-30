# CareBridge RAG Corpus — Master Specification

Status: draft for approval. Nothing here is implemented yet.

All data is synthetic. No real patients, doctors, or clinic records are used. The corpus lives
outside the operational tables (`profiles`, `doctors`, `appointments`, `prescriptions`, `bills`).

---

## 1. Locked decisions

| Decision | Value |
|---|---|
| Clean corpus | 2,700 visit notes + 2,300 prescriptions + 250 FAQ = **5,250** |
| Pairing | `VN-000001..VN-002300` pair 1:1 with `RX-000001..RX-002300` via `group_id` |
| Unpaired visits | `VN-002301..VN-002700` (no prescription) |
| FAQ | 250 distinct intents, one document per intent |
| Facts owner | A seeded script builds a manifest. The LLM writes prose only. |
| LLM output | CSV, 50 records per message |
| Pools | 900 patients, 36 doctors, 12 specializations |
| Noise | Generated later by script from clean documents. Not counted in the 5,250. |
| Embeddings | Decided later. Not needed for generation. |

---

## 2. Identifiers

| Kind | Format | Range |
|---|---|---|
| Visit note | `VN-000001` | `VN-000001`..`VN-002700` |
| Prescription | `RX-000001` | `RX-000001`..`RX-002300` |
| FAQ | `FAQ-000001` | `FAQ-000001`..`FAQ-000250` |
| Visit group | `VISIT-000001` | same number as the visit note |
| Synthetic patient | `PAT-000001` | `PAT-000001`..`PAT-000900` |
| Synthetic doctor | `DOC-001` | `DOC-001`..`DOC-036` |
| Specialization | `SPEC-01` | `SPEC-01`..`SPEC-12` |
| Diagnosis | `DX-0101` | two digits specialization + two digits diagnosis |
| FAQ intent | `FAQI-001` | `FAQI-001`..`FAQI-250` |

Rules:

- `VN-n`, `RX-n`, and `VISIT-n` share the same number `n` when paired.
- IDs never appear inside `content`.
- IDs are independent of Supabase UUIDs.

---

## 3. Formats

| Field | Format | Example |
|---|---|---|
| Date | `YYYY-MM-DD` | `2026-03-12` |
| Time slot | `HH:MM AM` / `HH:MM PM`, zero-padded | `03:30 PM` |
| Weekday (data) | `Sat Sun Mon Tue Wed Thu Fri` | `Thu` |
| Time zone | `Asia/Dhaka` | |
| Temperature | °F, one decimal | `101.4°F` |
| Blood pressure | `NNN/NN mmHg` | `152/96 mmHg` |
| Pulse | `NN bpm` | `88 bpm` |
| SpO2 | `NN%` | `96%` |
| Weight | `NN kg` | `72 kg` |
| Blood glucose | `N.N mmol/L` | `8.4 mmol/L` |
| Money | BDT, integer | `1200` |
| Visit date range | `2025-01-01` to `2026-09-28` | all visits in the past |
| Visit status | always `completed` | |

---

## 4. Clinic facts sheet

Every FAQ answer must use only these facts, the doctor table, and the specialization table.
Facts marked *(app)* match the real CareBridge app behaviour. Facts marked *(policy)* are
synthetic clinic policy chosen for this corpus.

**Identity**
- Name: CareBridge Clinic. *(policy)*
- Address: House 27, Road 9/A, Dhanmondi, Dhaka 1209 (fictional). *(policy)*
- Reception phone: +880 1711-000000 (fictional). *(policy)*
- Hours: Saturday to Thursday, 9:00 AM to 5:00 PM. Closed Friday and public holidays. *(policy)*
- Languages at reception: Bangla and English. *(policy)*
- Wheelchair ramp and lift at the entrance. Limited street parking only. *(policy)*
- Emergencies: call 999 or go to the nearest hospital emergency department. The clinic is not an emergency service. *(policy)*

**Accounts**
- Sign up with email and password, or with Google. *(app)*
- New accounts are patient accounts. Doctor and receptionist roles are assigned by reception. *(app)*
- Each person needs their own account. Family members cannot share one account. *(policy)*
- Patients see only their own appointments, prescriptions, and bills. *(app)*
- For sign-in problems or account deletion, contact reception. *(policy)*

**Booking**
- Book in the app: choose a doctor, a date, a time slot, and enter a reason. *(app)*
- A new booking has status `requested`. *(app)*
- Reception confirms the booking and the status becomes `confirmed`. *(app)*
- Reception confirms requested bookings within the same working day. *(policy)*
- Only the doctor's working days and listed slots can be booked. *(app)*
- A slot that is already booked cannot be chosen. *(app)*
- Walk-ins are seen only if a slot is free. Booking in the app is preferred. *(policy)*
- First visit: bring photo ID, previous prescriptions, and recent test reports. *(policy)*
- Arriving more than 15 minutes late may require rescheduling. *(policy)*

**Cancel and reschedule**
- Patients can cancel only while the status is `requested` or `confirmed`. *(app)*
- Patients can reschedule only `requested` or `confirmed` appointments, to a future date, on the doctor's working day and slot. *(app)*
- Completed appointments cannot be cancelled or rescheduled. *(app)*
- There is no cancellation fee. *(policy)*

**Waitlist**
- If the wanted slot or day is full, the patient can join the waitlist for that doctor and day. *(app)*
- One open waitlist entry per patient, doctor, and day. *(app)*
- When a slot is freed, the next waitlisted patient gets an offer. *(app)*
- The patient has **120 minutes** to accept the offer in My Appointments. *(app)*
- An offer not accepted in time expires and passes to the next patient. *(app)*
- Patients can leave the waitlist at any time. *(app)*

**Reminders and no-shows**
- A reminder notification is sent within the 24 hours before a confirmed appointment. *(app)*
- Notifications appear under the bell icon in the app. There is no SMS. *(app / policy)*
- If a confirmed appointment is not completed 1 hour after its start time, it is flagged as a possible no-show. *(app)*
- Reception follows up on no-shows and may contact the patient. *(app / policy)*

**Prescriptions**
- The doctor writes the prescription at the end of the consultation. The appointment becomes `completed`. *(app)*
- Patients see prescriptions under My Prescriptions. *(app)*
- A prescription shows date, doctor, diagnosis, medicines (name, dosage, frequency, duration), and notes. *(app)*
- One prescription per appointment. *(app)*
- For refills, book a follow-up appointment. *(policy)*
- To report an error on a prescription, contact reception. *(policy)*

**Billing**
- Reception creates the bill after the visit. *(app)*
- Bill status is `unpaid` or `paid`. *(app)*
- Payment methods: cash, card, or mobile banking. *(app)*
- Payment is made after the visit, so there is no advance payment and no refund process. *(policy)*
- Patients get their invoice from reception; the AI assistant can show their bills. *(app)*
- The consultation fee depends on the doctor (see doctor table). *(app)*

**AI assistant**
- The assistant can look up the patient's own appointments, prescriptions, bills, and profile. *(app)*
- The assistant can prepare a booking, cancellation, or reschedule as a proposal card. Nothing changes until the patient presses Confirm. *(app)*
- The assistant gives general information and specialization guidance only. It is not medical advice and does not diagnose. *(app)*
- Chats are private to the user. *(app)*

---

## 5. Specializations

| ID | Specialization | Base fee (BDT) | Room prefix |
|---|---|---|---|
| SPEC-01 | General Medicine | 600 | 1 |
| SPEC-02 | Cardiology | 1200 | 2 |
| SPEC-03 | Pulmonology | 1000 | 3 |
| SPEC-04 | Gastroenterology | 1000 | 4 |
| SPEC-05 | Endocrinology | 1000 | 5 |
| SPEC-06 | Dermatology | 800 | 6 |
| SPEC-07 | Orthopedics | 1000 | 7 |
| SPEC-08 | Neurology | 1200 | 8 |
| SPEC-09 | ENT | 800 | 9 |
| SPEC-10 | Ophthalmology | 800 | 10 |
| SPEC-11 | Obstetrics and Gynecology | 1000 | 11 |
| SPEC-12 | Psychiatry | 1200 | 12 |

Use these names exactly. No pediatrics: all patients are adults (18–85).

---

## 6. Doctors

Day patterns:

- `D1` = Sat, Mon, Wed
- `D2` = Sun, Tue, Thu
- `D3` = Sat, Sun, Mon, Tue, Wed

Slot templates:

- `S1` = 09:00 AM, 09:30 AM, 10:00 AM, 10:30 AM, 11:00 AM, 11:30 AM, 12:00 PM, 12:30 PM
- `S2` = 02:00 PM, 02:30 PM, 03:00 PM, 03:30 PM, 04:00 PM, 04:30 PM
- `S3` = 10:00 AM, 10:30 AM, 11:00 AM, 11:30 AM, 03:00 PM, 03:30 PM, 04:00 PM, 04:30 PM

Per specialization: doctor 1 = `D1/S1`, base fee; doctor 2 = `D2/S2`, base fee; doctor 3 = `D3/S3`,
base fee + 200 (senior consultant). Room = `Room <prefix>0<1|2|3>` (e.g. `Room 201`, `Room 1103`).

All names are fictional.

| Ref | Name | Specialization | Days | Slots | Fee | Room | Experience | Languages |
|---|---|---|---|---|---|---|---|---|
| DOC-001 | Dr. Farhana Kabir | General Medicine | D1 | S1 | 600 | Room 101 | 9 years | Bangla, English |
| DOC-002 | Dr. Tanvir Ahmed | General Medicine | D2 | S2 | 600 | Room 102 | 6 years | Bangla, English |
| DOC-003 | Dr. Nusrat Jahan | General Medicine | D3 | S3 | 800 | Room 103 | 17 years | Bangla, English, Hindi |
| DOC-004 | Dr. Mahmudul Hasan | Cardiology | D1 | S1 | 1200 | Room 201 | 12 years | Bangla, English |
| DOC-005 | Dr. Sabrina Chowdhury | Cardiology | D2 | S2 | 1200 | Room 202 | 8 years | Bangla, English |
| DOC-006 | Dr. Rafiqul Islam | Cardiology | D3 | S3 | 1400 | Room 203 | 22 years | Bangla, English, Arabic |
| DOC-007 | Dr. Shirin Akter | Pulmonology | D1 | S1 | 1000 | Room 301 | 10 years | Bangla, English |
| DOC-008 | Dr. Arif Hossain | Pulmonology | D2 | S2 | 1000 | Room 302 | 7 years | Bangla, English |
| DOC-009 | Dr. Kamrul Hasan | Pulmonology | D3 | S3 | 1200 | Room 303 | 19 years | Bangla, English |
| DOC-010 | Dr. Nasrin Sultana | Gastroenterology | D1 | S1 | 1000 | Room 401 | 11 years | Bangla, English |
| DOC-011 | Dr. Imran Kabir | Gastroenterology | D2 | S2 | 1000 | Room 402 | 5 years | Bangla, English |
| DOC-012 | Dr. Zahid Hasan | Gastroenterology | D3 | S3 | 1200 | Room 403 | 18 years | Bangla, English, Hindi |
| DOC-013 | Dr. Rumana Haque | Endocrinology | D1 | S1 | 1000 | Room 501 | 13 years | Bangla, English |
| DOC-014 | Dr. Saiful Alam | Endocrinology | D2 | S2 | 1000 | Room 502 | 6 years | Bangla, English |
| DOC-015 | Dr. Lubna Rahman | Endocrinology | D3 | S3 | 1200 | Room 503 | 20 years | Bangla, English |
| DOC-016 | Dr. Tahmina Begum | Dermatology | D1 | S1 | 800 | Room 601 | 9 years | Bangla, English |
| DOC-017 | Dr. Asif Mahmud | Dermatology | D2 | S2 | 800 | Room 602 | 4 years | Bangla, English |
| DOC-018 | Dr. Sadia Islam | Dermatology | D3 | S3 | 1000 | Room 603 | 15 years | Bangla, English |
| DOC-019 | Dr. Mostafizur Rahman | Orthopedics | D1 | S1 | 1000 | Room 701 | 14 years | Bangla, English |
| DOC-020 | Dr. Jannatul Ferdous | Orthopedics | D2 | S2 | 1000 | Room 702 | 7 years | Bangla, English |
| DOC-021 | Dr. Habibur Rahman | Orthopedics | D3 | S3 | 1200 | Room 703 | 24 years | Bangla, English |
| DOC-022 | Dr. Selina Parvin | Neurology | D1 | S1 | 1200 | Room 801 | 12 years | Bangla, English |
| DOC-023 | Dr. Rezaul Karim | Neurology | D2 | S2 | 1200 | Room 802 | 8 years | Bangla, English |
| DOC-024 | Dr. Moinul Haque | Neurology | D3 | S3 | 1400 | Room 803 | 21 years | Bangla, English, Hindi |
| DOC-025 | Dr. Fahmida Yasmin | ENT | D1 | S1 | 800 | Room 901 | 10 years | Bangla, English |
| DOC-026 | Dr. Shahadat Hossain | ENT | D2 | S2 | 800 | Room 902 | 6 years | Bangla, English |
| DOC-027 | Dr. Towhid Alam | ENT | D3 | S3 | 1000 | Room 903 | 16 years | Bangla, English |
| DOC-028 | Dr. Shamima Nasrin | Ophthalmology | D1 | S1 | 800 | Room 1001 | 11 years | Bangla, English |
| DOC-029 | Dr. Anisur Rahman | Ophthalmology | D2 | S2 | 800 | Room 1002 | 5 years | Bangla, English |
| DOC-030 | Dr. Mehedi Hasan | Ophthalmology | D3 | S3 | 1000 | Room 1003 | 18 years | Bangla, English |
| DOC-031 | Dr. Rokeya Khatun | Obstetrics and Gynecology | D1 | S1 | 1000 | Room 1101 | 15 years | Bangla, English |
| DOC-032 | Dr. Sharmin Akter | Obstetrics and Gynecology | D2 | S2 | 1000 | Room 1102 | 8 years | Bangla, English |
| DOC-033 | Dr. Nazma Begum | Obstetrics and Gynecology | D3 | S3 | 1200 | Room 1103 | 23 years | Bangla, English |
| DOC-034 | Dr. Ishrat Jahan | Psychiatry | D1 | S1 | 1200 | Room 1201 | 10 years | Bangla, English |
| DOC-035 | Dr. Faisal Karim | Psychiatry | D2 | S2 | 1200 | Room 1202 | 7 years | Bangla, English |
| DOC-036 | Dr. Mahbuba Rahman | Psychiatry | D3 | S3 | 1400 | Room 1203 | 19 years | Bangla, English |

---

## 7. Medicine vocabulary

Medicine format: `name | dosage | frequency | duration`. All four are strings.

**Frequency (exact values)**

`Once daily`, `Twice daily`, `Three times daily`, `Four times daily`, `At bedtime`,
`Once daily before breakfast`, `Every 6 hours as needed`, `Every 8 hours as needed`, `As needed`,
`After each loose stool`, `Once weekly`, `Single dose`

**Duration (exact values)**

`1 day`, `3 days`, `5 days`, `7 days`, `10 days`, `14 days`, `1 month`, `2 months`, `3 months`,
`Ongoing`, `Until follow-up`

**Dosage forms**

- Tablets and capsules: `<number> mg`, `<number> mcg`, `<number> g`, `<number> IU`
- Liquids: `<number> ml`
- Inhalers and sprays: `1 puff`, `2 puffs`, `2 sprays per nostril`
- Eye drops: `1 drop in each eye`, `1 drop in affected eye`
- Topicals: `Apply thin layer`
- Sachets: `1 sachet in 500 ml water`

Generic names only. No brand names. No controlled drugs (no benzodiazepines, opioids, pregabalin,
gabapentin, stimulants).

---

## 8. Diagnosis catalogue

Columns: ID, diagnosis (exact string), complaint cues (lay words, never the specialization name),
age range, sex, chronic, regimen (one medicine per line in the manifest).

### SPEC-01 General Medicine

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0101 | Viral fever | fever for 2–3 days, body aches, tiredness, mild headache | 18–70 | any | no | Paracetamol \| 500 mg \| Every 6 hours as needed \| 5 days |
| DX-0102 | Typhoid fever | fever rising each day for over a week, belly discomfort, poor appetite, recent street food | 18–60 | any | no | Azithromycin \| 500 mg \| Once daily \| 7 days; Paracetamol \| 500 mg \| Every 6 hours as needed \| 5 days |
| DX-0103 | Dengue fever | sudden high fever, pain behind the eyes, severe body ache, faint rash, rainy season | 18–65 | any | no | Paracetamol \| 500 mg \| Every 6 hours as needed \| 5 days; Oral rehydration salts \| 1 sachet in 500 ml water \| Three times daily \| 5 days |
| DX-0104 | Iron deficiency anaemia | constant tiredness, breathless on stairs, pale skin, brittle nails | 18–60 | any | yes | Ferrous sulfate \| 200 mg \| Twice daily \| 3 months; Folic acid \| 5 mg \| Once daily \| 3 months |

Dengue advice must say: avoid ibuprofen and aspirin; repeat platelet count.

### SPEC-02 Cardiology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0201 | Essential hypertension | morning headaches, high reading at a pharmacy, no other symptoms | 30–85 | any | yes | Amlodipine \| 5 mg \| Once daily \| Ongoing (alt: Losartan \| 50 mg \| Once daily \| Ongoing) |
| DX-0202 | Stable angina | chest tightness when walking fast or climbing, eases with rest within minutes | 45–85 | any | yes | Aspirin \| 75 mg \| Once daily \| Ongoing; Atorvastatin \| 20 mg \| At bedtime \| Ongoing; Glyceryl trinitrate spray \| 1 puff \| As needed \| Ongoing |
| DX-0203 | Dyslipidaemia | high cholesterol on a routine test, family history of heart attack | 30–80 | any | yes | Atorvastatin \| 10 mg \| At bedtime \| 3 months (alt: Rosuvastatin \| 10 mg \| At bedtime \| 3 months) |
| DX-0204 | Atrial fibrillation | irregular fast heartbeat, fluttering in chest, dizzy spells | 55–85 | any | yes | Bisoprolol \| 2.5 mg \| Once daily \| Ongoing; Apixaban \| 5 mg \| Twice daily \| Ongoing |

### SPEC-03 Pulmonology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0301 | Bronchial asthma | wheezing, night-time cough, tight chest with dust or cold air | 18–70 | any | yes | Salbutamol inhaler \| 2 puffs \| Every 6 hours as needed \| Ongoing; Budesonide-formoterol inhaler \| 2 puffs \| Twice daily \| 3 months |
| DX-0302 | COPD exacerbation | long-time smoker, breathlessness worse for days, more sputum | 50–85 | any | yes | Tiotropium inhaler \| 1 puff \| Once daily \| Ongoing; Prednisolone \| 40 mg \| Once daily \| 5 days; Amoxicillin-clavulanate \| 625 mg \| Three times daily \| 7 days |
| DX-0303 | Community-acquired pneumonia | fever, cough with yellow or green sputum, sharp chest pain on breathing in | 18–80 | any | no | Amoxicillin \| 500 mg \| Three times daily \| 7 days; Azithromycin \| 500 mg \| Once daily \| 3 days; Paracetamol \| 500 mg \| Every 6 hours as needed \| 5 days |
| DX-0304 | Acute bronchitis | cough for 1–2 weeks after a cold, mild wheeze, no high fever | 18–75 | any | no | Dextromethorphan syrup \| 10 ml \| Three times daily \| 5 days; Paracetamol \| 500 mg \| Every 6 hours as needed \| 3 days |

### SPEC-04 Gastroenterology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0401 | Gastro-oesophageal reflux disease | burning behind the breastbone after meals, sour taste, worse lying down | 18–80 | any | yes | Omeprazole \| 20 mg \| Once daily before breakfast \| 1 month |
| DX-0402 | Peptic ulcer disease | gnawing upper belly pain, wakes at night, eases after food | 20–75 | any | no | Omeprazole \| 20 mg \| Twice daily \| 14 days; Amoxicillin \| 1 g \| Twice daily \| 14 days; Clarithromycin \| 500 mg \| Twice daily \| 14 days |
| DX-0403 | Irritable bowel syndrome | cramping belly pain, alternating loose and hard stools, worse with stress | 18–55 | any | yes | Mebeverine \| 135 mg \| Three times daily \| 1 month |
| DX-0404 | Acute gastroenteritis | loose watery stools, vomiting, after eating outside | 18–75 | any | no | Oral rehydration salts \| 1 sachet in 500 ml water \| After each loose stool \| 3 days; Ondansetron \| 4 mg \| Every 8 hours as needed \| 3 days; Zinc \| 20 mg \| Once daily \| 10 days |

### SPEC-05 Endocrinology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0501 | Type 2 diabetes mellitus | always thirsty, passing urine often, weight loss, slow-healing cuts | 30–85 | any | yes | Metformin \| 500 mg \| Twice daily \| Ongoing (alt add: Gliclazide \| 80 mg \| Once daily before breakfast \| Ongoing) |
| DX-0502 | Hypothyroidism | weight gain, feeling cold, dry skin, slow and tired | 25–75 | any (70% female) | yes | Levothyroxine \| 50 mcg \| Once daily before breakfast \| Ongoing |
| DX-0503 | Hyperthyroidism | weight loss despite eating, racing heart, heat intolerance, shaky hands | 20–60 | any (70% female) | yes | Carbimazole \| 10 mg \| Twice daily \| 1 month; Propranolol \| 10 mg \| Three times daily \| 1 month |
| DX-0504 | Vitamin D deficiency | aching bones, low energy, works indoors all day | 18–75 | any | no | Cholecalciferol \| 40000 IU \| Once weekly \| 2 months; Calcium carbonate \| 500 mg \| Twice daily \| 3 months |

### SPEC-06 Dermatology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0601 | Atopic eczema | itchy dry patches on elbows and knees, worse in winter | 18–60 | any | yes | Hydrocortisone 1% cream \| Apply thin layer \| Twice daily \| 7 days; Emollient cream \| Apply thin layer \| Three times daily \| Ongoing |
| DX-0602 | Acne vulgaris | pimples and blackheads on face and back | 18–30 | any | yes | Benzoyl peroxide 5% gel \| Apply thin layer \| At bedtime \| 3 months; Doxycycline \| 100 mg \| Once daily \| 2 months |
| DX-0603 | Tinea corporis | ring-shaped itchy red rash, humid weather, shared towels | 18–65 | any | no | Clotrimazole 1% cream \| Apply thin layer \| Twice daily \| 14 days; Terbinafine \| 250 mg \| Once daily \| 14 days |
| DX-0604 | Acute urticaria | itchy raised welts that come and go, after a new food or medicine | 18–70 | any | no | Cetirizine \| 10 mg \| Once daily \| 14 days (alt: Fexofenadine \| 180 mg \| Once daily \| 14 days) |

### SPEC-07 Orthopedics

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0701 | Lumbar muscle strain | low back pain after lifting something heavy, stiff when bending | 20–65 | any | no | Ibuprofen \| 400 mg \| Three times daily \| 5 days; Tolperisone \| 150 mg \| Three times daily \| 7 days |
| DX-0702 | Knee osteoarthritis | knee pain on stairs, short morning stiffness, creaking knee | 50–85 | any | yes | Paracetamol \| 1000 mg \| Three times daily \| 1 month; Diclofenac 1% gel \| Apply thin layer \| Three times daily \| 14 days |
| DX-0703 | Ankle sprain | twisted ankle during sport or on stairs, swelling, pain on walking | 18–55 | any | no | Ibuprofen \| 400 mg \| Three times daily \| 5 days |
| DX-0704 | Adhesive capsulitis | shoulder stiff for weeks, cannot raise arm or reach behind back | 40–70 | any | yes | Naproxen \| 500 mg \| Twice daily \| 14 days |

Ankle sprain advice: rest, ice, compression, elevation. Adhesive capsulitis advice: physiotherapy.

### SPEC-08 Neurology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0801 | Migraine | one-sided throbbing headache, light hurts eyes, nausea | 18–55 | any (65% female) | yes | Sumatriptan \| 50 mg \| As needed \| Until follow-up; Propranolol \| 40 mg \| Twice daily \| 3 months |
| DX-0802 | Tension-type headache | band-like pressure around the head, long screen hours, stress | 18–65 | any | no | Paracetamol \| 500 mg \| As needed \| 7 days; Amitriptyline \| 10 mg \| At bedtime \| 1 month |
| DX-0803 | Peripheral neuropathy | burning and tingling in both feet, numbness, often diabetic | 40–85 | any | yes | Duloxetine \| 30 mg \| Once daily \| 3 months; Methylcobalamin \| 500 mcg \| Three times daily \| 3 months |
| DX-0804 | Benign paroxysmal positional vertigo | brief spinning when turning in bed or looking up | 30–80 | any | no | Betahistine \| 16 mg \| Three times daily \| 14 days |

Vertigo advice: Epley manoeuvre shown in clinic.

### SPEC-09 ENT

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-0901 | Acute otitis media | ear pain, blocked ear after a cold, mild fever | 18–60 | any | no | Amoxicillin \| 500 mg \| Three times daily \| 7 days; Paracetamol \| 500 mg \| Every 6 hours as needed \| 3 days |
| DX-0902 | Allergic rhinitis | sneezing fits, runny nose, itchy eyes, dust or season triggers | 18–65 | any | yes | Fluticasone nasal spray \| 2 sprays per nostril \| Once daily \| 1 month; Cetirizine \| 10 mg \| Once daily \| 14 days |
| DX-0903 | Acute sinusitis | pressure over cheeks and forehead, blocked nose, thick discharge over 10 days | 18–70 | any | no | Amoxicillin-clavulanate \| 625 mg \| Three times daily \| 7 days; Saline nasal spray \| 2 sprays per nostril \| Three times daily \| 7 days |
| DX-0904 | Acute tonsillitis | sore throat, painful swallowing, fever, swollen tonsils | 18–45 | any | no | Phenoxymethylpenicillin \| 500 mg \| Four times daily \| 10 days; Paracetamol \| 500 mg \| Every 6 hours as needed \| 3 days |

### SPEC-10 Ophthalmology

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-1001 | Allergic conjunctivitis | itchy watery red eyes in both eyes, seasonal | 18–60 | any | no | Olopatadine 0.1% eye drops \| 1 drop in each eye \| Twice daily \| 14 days |
| DX-1002 | Bacterial conjunctivitis | red eye with sticky yellow discharge, eyelids stuck in the morning | 18–70 | any | no | Moxifloxacin 0.5% eye drops \| 1 drop in affected eye \| Three times daily \| 7 days |
| DX-1003 | Dry eye syndrome | gritty burning eyes, long screen time, worse in air conditioning | 25–80 | any | yes | Carboxymethylcellulose 0.5% eye drops \| 1 drop in each eye \| Four times daily \| 1 month |
| DX-1004 | Hordeolum | painful red lump at the edge of the eyelid | 18–60 | any | no | Chloramphenicol 1% eye ointment \| Apply thin layer \| Three times daily \| 7 days |

Hordeolum advice: warm compress four times a day; do not squeeze.

### SPEC-11 Obstetrics and Gynecology (female patients only)

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-1101 | Uncomplicated urinary tract infection | burning when passing urine, going often, lower belly ache | 18–65 | female | no | Nitrofurantoin \| 100 mg \| Twice daily \| 5 days |
| DX-1102 | Polycystic ovary syndrome | irregular periods, acne, weight gain, extra facial hair | 18–35 | female | yes | Metformin \| 500 mg \| Twice daily \| 3 months |
| DX-1103 | Primary dysmenorrhoea | painful cramps in the first days of each period | 18–30 | female | no | Mefenamic acid \| 500 mg \| Three times daily \| 3 days |
| DX-1104 | Vulvovaginal candidiasis | itching and thick white discharge | 18–55 | female | no | Fluconazole \| 150 mg \| Single dose \| 1 day |

No pregnancy-related visits (avoids pregnancy dosing).

### SPEC-12 Psychiatry

| ID | Diagnosis | Complaint cues | Age | Sex | Chronic | Regimen |
|---|---|---|---|---|---|---|
| DX-1201 | Generalized anxiety disorder | constant worry for months, restless, tense muscles, poor sleep | 18–65 | any | yes | Sertraline \| 50 mg \| Once daily \| 3 months |
| DX-1202 | Depressive episode | low mood and loss of interest for over 3 weeks, poor sleep, low energy | 18–70 | any | yes | Escitalopram \| 10 mg \| Once daily \| 3 months |
| DX-1203 | Chronic insomnia | trouble falling asleep most nights for over 3 months | 25–75 | any | yes | Melatonin \| 3 mg \| At bedtime \| 1 month |
| DX-1204 | Panic disorder | sudden attacks of racing heart, breathlessness, fear of dying, normal heart tests | 18–50 | any | yes | Sertraline \| 25 mg \| Once daily \| 1 month; Propranolol \| 10 mg \| As needed \| 1 month |

Depressive episode notes must state that the patient denies thoughts of self-harm and that a safety
plan and emergency contact (999) were discussed.

---

## 9. Patients

- 900 patients, `PAT-000001`..`PAT-000900`.
- Fictional Bangladeshi full names from script name lists. Full names are unique.
- Stored: `patient_ref`, `full_name`, `gender` (`male` / `female`), `date_of_birth`.
- Age at visit is computed from `date_of_birth` and `visit_date` (18–85).
- Gender split about 50/50. Obstetrics and Gynecology visits use female patients only.
- Visits per patient: 1–8, mean 3.0 (total 2,700).
- Chronic diagnoses produce repeat visits, usually with the same doctor, 1–6 months apart.
- Comorbidity per patient: none (60%), Essential hypertension, Type 2 diabetes mellitus,
  Bronchial asthma, Hypothyroidism. Comorbidity is stable across that patient's visits.

---

## 10. Visit manifest rules

- Each visit: patient, doctor, date, slot, diagnosis from that doctor's specialization.
- `visit_date` weekday must be in the doctor's day pattern. `time_slot` must be in the doctor's slot template.
- No two visits share (doctor, date, time slot). No patient has two visits on the same date.
- Diagnosis must respect the age range and sex rules.
- Specialization distribution: balanced, 225 visits each (±10%). Diagnosis distribution inside a
  specialization: roughly even.
- Paired visits (`VN-000001..VN-002300`) carry the regimen from Section 8 (one alt may be chosen).
- Unpaired visits (`VN-002301..VN-002700`) have no new medicine. `plan_note` is one of:
  - chronic follow-up: continue current medicines, no new prescription issued;
  - tests ordered before starting treatment;
  - lifestyle and self-care advice only;
  - referral to another specialization in this clinic.

**Uniqueness anchor**

Each visit gets three anchor fields assigned by the script:

- `anchor_occupation` from the occupation list (Section 13);
- `anchor_context` — a short situation phrase tied to the complaint (e.g. "started after a wedding feast in Sylhet");
- `anchor_vital` — one exact measurement (e.g. `BP 152/96 mmHg`, `temperature 102.4°F`).

The tuple (`anchor_occupation`, `anchor_context`, `anchor_vital`) is unique across the corpus.
The prose must contain all three.

**Difficulty quotas (visit notes)**

| `difficulty` | Share | Count | Meaning |
|---|---|---|---|
| `normal` | 80% | 2,160 | typical presentation, 120–220 words |
| `rare_presentation` | 8% | 216 | atypical symptoms given in `presentation_hint`, 120–220 words |
| `long` | 5% | 135 | 350–500 words, detailed history, exam, and social history |
| `confusable` | 7% | 189 | hard negative: near-copy of `confusable_with` visit, differs in 1–2 anchor facts |

`edge_tags` (zero or more): `multi_visit`, `comorbidity`, `referral`, `elderly`.
Prescriptions inherit `difficulty` and `edge_tags` from their visit. `difficulty`, `edge_tags`, and
`confusable_with` are evaluation metadata and are not sent to the LLM.

**Other visit fields sent to the LLM**

- `visit_kind`: `first visit` or `follow-up visit` (a later visit in the same episode). Follow-up
  notes describe the visit as a review of an existing problem.
- `must_include`: a sentence the note must contain in substance (for example, the self-harm safety
  statement for depression). Null for most visits.
- Anchor contexts that imply a job or study are only given to patients whose occupation fits.

---

## 11. Record content rules (what the LLM writes)

`content` is one line of plain English. No line breaks. No double-quote characters. No IDs.

**visit_note** (paired: mentions a prescription was issued; unpaired: says no new medicine)

- Start with the header: `Visit note | <visit_date> <time_slot> | <doctor_name>, <specialization> | Patient: <patient_name>, <age>, <gender>.`
- Then prose: chief complaint in the patient's words (paraphrase `chief_complaint_hint`), history
  including `anchor_occupation` and `anchor_context`, comorbidity if any, exam with `anchor_vital`
  exactly as given plus `other_vitals`, assessment naming `diagnosis` exactly, and plan.
- Paired visits: plan says a prescription was issued and gives advice and follow-up. **Do not name
  medicines or doses in the visit note.**
- Unpaired visits: plan uses `plan_note`, advice, and follow-up. State that no new medicine was prescribed.
- Never mention the specialization name inside the chief complaint sentence.

**prescription**

- Start with the header: `Prescription | <visit_date> | <doctor_name>, <specialization> | Patient: <patient_name>, <age>, <gender> | Diagnosis: <diagnosis> | Medicines:`
- Then list every medicine exactly: `1) <name> <dosage>, <frequency>, <duration>; 2) ...`
- Then `Advice:` with 1–3 natural sentences from `advice`, then `Follow-up: <follow_up>.`
- 60–120 words. No extra medicines. No changed doses.

**faq**

- Format: `Q: <question> A: <answer>`
- Question in a patient's voice, paraphrasing `question_hint`.
- Answer 40–120 words. Include every item in `answer_facts`. Add no facts outside Section 4–6.

---

## 12. FAQ intents (250)

| Group | Count | Source of facts |
|---|---|---|
| General clinic (listed below) | 70 | Section 4 |
| Symptom routing: which specialist for a diagnosis's complaint cues | 48 | Section 8 + doctor names, with not-medical-advice line |
| Doctor schedule: days, slot range, room | 36 | Section 6 |
| Doctor fee and payment | 36 | Section 6 + Section 4 billing |
| Doctor profile: specialization, experience, languages | 36 | Section 6 |
| Specialization doctor list | 12 | Section 6 |
| Specialization visit preparation | 12 | Section 4 first-visit facts + specialization-specific tip |

General clinic intents (`FAQI-001`..`FAQI-070`):

- **Accounts (8):** create account; sign in with Google; cannot sign in; update profile details;
  who can see my records; family members sharing an account; how roles are assigned; delete account.
- **Booking (12):** how to book; information needed to book; choosing a doctor; choosing a time slot;
  meaning of requested status; how I know it is confirmed; how long confirmation takes; booking a
  full slot; booking for someone else; walk-ins; what to bring on first visit; late arrival.
- **Cancel and reschedule (8):** how to cancel; which appointments can be cancelled; cancellation fee;
  how to reschedule; reschedule rules; changing a completed appointment; what counts as a no-show;
  what happens after a no-show.
- **Waitlist (6):** what the waitlist is; how to join; how offers arrive; how long to accept;
  expired offer; leaving the waitlist.
- **Notifications (5):** 24-hour reminder; where notifications appear; no reminder received;
  SMS reminders; waitlist offer notifications.
- **Prescriptions (8):** where to find my prescription; when it appears; what it contains;
  one prescription per visit; refills; error on prescription; can the assistant change medicines;
  side effects or worsening symptoms.
- **Billing (10):** when the bill is created; how to pay; payment methods; mobile banking; card;
  unpaid vs paid; invoice; why fees differ; where to see fees; refunds and advance payment.
- **Clinic info (8):** opening hours; Friday; address; phone; parking; wheelchair access;
  languages; emergencies.
- **AI assistant (5):** what the assistant can do; is it medical advice; can it book for me;
  privacy of chats; what to do if the assistant is wrong.

---

## 13. Occupation list

rickshaw puller, garment factory worker, bank officer, schoolteacher, university student, software
developer, shopkeeper, bus driver, CNG auto-rickshaw driver, security guard, nurse, homemaker, retired
civil servant, journalist, restaurant cook, delivery rider, construction worker, tailor, pharmacist,
accountant, call centre agent, farmer, fisherman, police constable, electrician, lawyer, graphic
designer, textile engineer, sales representative, madrasa teacher, beautician, mobile phone repair
technician, NGO field officer, hotel receptionist, cricket coach, photographer, architect, garment
merchandiser, ride-share driver, office cleaner

---

## 14. Manifest files (script output)

Generate with `node scripts/generate-manifest.mjs` (run from `carebridge-rag/`). The
script is deterministic: the same seed always produces the same files.

| File | Content |
|---|---|
| `manifest/doctors.csv` | Section 6 table |
| `manifest/patients.csv` | Section 9 |
| `manifest/visits.jsonl` | one row per visit: all visit facts, anchors, difficulty, regimen |
| `manifest/faq_intents.jsonl` | one row per FAQ intent with `question_hint` and `answer_facts` |
| `manifest/llm_input/*.jsonl` | 50-row slices to paste into the LLM, per record type |
| `manifest/batches.csv` | slice id, record type, first and last `doc_id`, row count |
| `manifest/summary.json` | counts by specialization, difficulty, plan, and patient visit histogram |

Generator seed is fixed and recorded in every row as `generator_seed`.

---

## 15. Final record schema (after merge)

The LLM returns `doc_id, group_id, record_type, content`. The merge step joins the manifest by `doc_id`.

| Field | Type | Notes |
|---|---|---|
| `doc_id` | text | `VN-`, `RX-`, `FAQ-` |
| `record_type` | text | `visit_note`, `prescription`, `faq` |
| `group_id` | text / null | `VISIT-n`; null for FAQ |
| `content` | text | the only embedded text |
| `synthetic_patient_ref` | text / null | `PAT-n` |
| `synthetic_doctor_ref` | text / null | `DOC-n` |
| `patient_name` | text / null | |
| `doctor_name` | text / null | |
| `specialization` | text / null | Section 5 name |
| `diagnosis_id` | text / null | `DX-n` |
| `diagnosis` | text / null | exact Section 8 string |
| `medicines` | json array / null | `[{name, dosage, frequency, duration}]` (RX only) |
| `visit_date` | date / null | |
| `time_slot` | text / null | |
| `faq_intent` | text / null | `FAQI-n` |
| `faq_topic` | text / null | group name from Section 12 |
| `anchor_occupation`, `anchor_context`, `anchor_vital` | text / null | visit notes |
| `answer_facts` | json array | facts a correct answer must contain |
| `difficulty` | text | Section 10 |
| `edge_tags` | json array | |
| `confusable_with` | text / null | `doc_id` |
| `is_noise` | boolean | always false in the clean corpus |
| `noise_type` | text / null | set only on noise rows |
| `source_doc_id` | text / null | set only on noise rows |
| `batch_id` | text | e.g. `B01-M03` (batch 1, message 3) |
| `generator_model` | text | LLM used for the prose |
| `generator_seed` | integer | manifest seed |

`content` never contains evaluation metadata. `answer_facts`, `difficulty`, `edge_tags`, noise
fields, and batch fields stay out of the embedded text.

---

## 16. Batch plan

50 records per LLM message. One conversation = up to 10 messages (500 records).

| Batch | Records | Messages |
|---|---|---|
| B01–B05 | VN-000001..VN-002500 | 50 |
| B06 | VN-002501..VN-002700 + RX-000001..RX-000300 | 4 + 6 |
| B07–B10 | RX-000301..RX-002300 | 40 |
| B11 | FAQ-000001..FAQ-000250 | 5 |

Prescriptions may instead be rendered fully by the script from the manifest (they are mostly
structured). Decide before B06.

---

## 17. Validator checks (per LLM message)

Run `node scripts/validate-batch.mjs <slice>` from `carebridge-rag/` (or no argument to check every saved slice). It
reads `output/<slice>.csv` plus any `output/<slice>.fix<N>.csv`, writes `output/<slice>.report.json`,
and writes `output/<slice>.fix.txt` (a ready FIX message) when rows fail.

1. CSV parses with exactly 4 columns and the header `doc_id,group_id,record_type,content`.
2. Exactly the 50 expected `doc_id`s, no missing, no extra, no duplicates.
3. `group_id` and `record_type` match the manifest.
4. `content` has no line breaks, no double quotes, no `PAT-`, `DOC-`, `VN-`, `RX-`, `VISIT-`, `FAQ-` strings.
5. Header prefix matches the Section 11 template with manifest values.
6. Visit notes contain the exact `diagnosis`, `anchor_vital`, `anchor_occupation`, and key words of `anchor_context`.
7. Visit notes name no medicine from Section 8 (unless it appears in the row's own advice text),
   state a prescription for paired visits and "no new medicine" for unpaired visits, contain the
   comorbidity when not `none`, and contain `must_include` when set.
8. Prescriptions contain every manifest medicine line exactly, no other catalogue medicine, and
   `Follow-up: <follow_up>`.
9. FAQ answers contain every `answer_facts` item (numbers and names exact, most words present).
10. Word count: error below 75% of the minimum or above 130% of the maximum of `length_words`;
    warning outside the nominal range.
11. No near-duplicate text for visit notes and FAQ: token Jaccard similarity below 0.8 against all
    other saved records of the same type. Prescriptions are exempt because identical regimens
    share most of their text.

Warnings (not rejections): other vitals not found exactly, advice or follow-up weakly reflected,
chief complaint copied word for word, specialization in the chief complaint sentence.

Rejected rows are regenerated with the same manifest rows.

---

## 18. Noise plan (script, after the clean corpus)

- Noisy documents: copies of clean documents with typos, character swaps, dropped words, junk tokens,
  and random casing. `is_noise = true`, `noise_type` set, `source_doc_id` = original.
- Irrelevant documents: off-topic junk rows (`noise_type = irrelevant`), no `source_doc_id`.
- Noisy queries: typos and junk tokens injected into evaluation queries.
- Evaluation runs on clean index vs clean + noise index, with clean vs noisy queries.
