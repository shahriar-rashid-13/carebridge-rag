# CareBridge classification: specialization from symptoms

Data: 2580 synthetic visit notes. Input: complaint and history only (no doctor, specialization, findings, or diagnosis; names removed).
Split: about 80/20, stratified by label and grouped by patient so a patient's follow-up notes never appear on both sides (train 2064, held-out test 516), random_state 42.
Model: TF-IDF (word 1-2 grams, sublinear tf, English stop words) + logistic regression (C=10, balanced class weights), scikit-learn.
Stress test: the same held-out notes cut to the first sentence (the chief complaint only) with typos in about 30% of longer words.

| Task | Classes | Majority baseline | Held-out accuracy | Stress test accuracy | Macro F1 | 5-fold grouped CV (train) |
|---|---|---|---|---|---|---|
| Specialization | 12 | 8.3% | **100.0%** | 98.4% | 1.000 | 100.0% ± 0.0% |
| Diagnosis (harder, extra) | 48 | 4.5% | **100.0%** | 98.1% | 1.000 | 100.0% ± 0.0% |

Target: at least 70% held-out accuracy. Result: **PASS**.

Outside test 1: the 48 "Symptom routing" FAQ questions (short first-person questions, never seen in training): 97.9% accuracy.

Outside test 2: 48 hand-written lay descriptions in `eval/symptom-queries.json` (4 per specialization, different wording from the corpus): 79.2% accuracy.

- Miss: "When I rush up the stairs my chest feels heavy and tight, then it goes away after I sit for a bit." true Cardiology, predicted Pulmonology
- Miss: "I smoked for 30 years and lately I'm much more breathless and coughing up more phlegm." true Pulmonology, predicted General Medicine
- Miss: "My tummy cramps a lot and I go back and forth between constipation and diarrhoea." true Gastroenterology, predicted Endocrinology
- Miss: "I hardly go outside, my bones ache all the time and I feel weak." true Endocrinology, predicted Obstetrics and Gynecology
- Miss: "My knees creak and ache going down stairs and feel stiff for a few minutes after I wake." true Orthopedics, predicted Obstetrics and Gynecology
- Miss: "It hurts a lot to swallow and my tonsils look swollen with white spots." true ENT, predicted Obstetrics and Gynecology
- Miss: "It stings when I urinate and I feel like I need to go all the time." true Obstetrics and Gynecology, predicted Neurology
- Miss: "For over a month I've felt empty and sad and nothing I used to enjoy interests me." true Psychiatry, predicted Cardiology
- Miss: "I lie awake for hours every night and feel like a zombie the next day." true Psychiatry, predicted Neurology
- Miss: "Out of nowhere my heart pounds, I can't breathe and I think I'm going to die, then it passes." true Psychiatry, predicted Endocrinology

Accuracy by record difficulty (held-out set):

| Difficulty | n | Accuracy |
|---|---|---|
| confusable | 25 | 100.0% |
| long | 19 | 100.0% |
| normal | 429 | 100.0% |
| rare_presentation | 43 | 100.0% |

Per-class results (specialization):

| Specialization | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| General Medicine | 1.00 | 1.00 | 1.00 | 43 |
| Cardiology | 1.00 | 1.00 | 1.00 | 44 |
| Pulmonology | 1.00 | 1.00 | 1.00 | 42 |
| Gastroenterology | 1.00 | 1.00 | 1.00 | 44 |
| Endocrinology | 1.00 | 1.00 | 1.00 | 42 |
| Dermatology | 1.00 | 1.00 | 1.00 | 43 |
| Orthopedics | 1.00 | 1.00 | 1.00 | 44 |
| Neurology | 1.00 | 1.00 | 1.00 | 42 |
| ENT | 1.00 | 1.00 | 1.00 | 43 |
| Ophthalmology | 1.00 | 1.00 | 1.00 | 43 |
| Obstetrics and Gynecology | 1.00 | 1.00 | 1.00 | 42 |
| Psychiatry | 1.00 | 1.00 | 1.00 | 44 |

Confusion matrix (rows = true, columns = predicted):

| | GenMed | Cardio | Pulmo | Gastro | Endo | Derm | Ortho | Neuro | ENT | Ophth | ObGyn | Psych |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **GenMed** | 43 | · | · | · | · | · | · | · | · | · | · | · |
| **Cardio** | · | 44 | · | · | · | · | · | · | · | · | · | · |
| **Pulmo** | · | · | 42 | · | · | · | · | · | · | · | · | · |
| **Gastro** | · | · | · | 44 | · | · | · | · | · | · | · | · |
| **Endo** | · | · | · | · | 42 | · | · | · | · | · | · | · |
| **Derm** | · | · | · | · | · | 43 | · | · | · | · | · | · |
| **Ortho** | · | · | · | · | · | · | 44 | · | · | · | · | · |
| **Neuro** | · | · | · | · | · | · | · | 42 | · | · | · | · |
| **ENT** | · | · | · | · | · | · | · | · | 43 | · | · | · |
| **Ophth** | · | · | · | · | · | · | · | · | · | 43 | · | · |
| **ObGyn** | · | · | · | · | · | · | · | · | · | · | 42 | · |
| **Psych** | · | · | · | · | · | · | · | · | · | · | · | 44 |

Held-out errors (first 10):

- none

## LLM classifier (zero-shot)

Model: LiteLLM carebridge-agent (gemini/gemini-3.1-flash-lite, OpenRouter fallbacks), zero-shot, temperature 0. Produced by `scripts/classify-llm.mjs`, run 2026-10-01T03:39:35.911Z.

| Test set | n | Accuracy |
|---|---|---|
| Hand-written lay descriptions | 48 | 89.6% |
| Held-out notes, stress form (10 per class) | 120 | 88.3% |

- Miss: "Since I came back from the village I've had a fever that won't go away and I keep feeling sick to my stomach." true General Medicine, predicted Gastroenterology
- Miss: "I get tired doing nothing, my face looks pale and I'm out of breath just walking to the shop." true General Medicine, predicted Cardiology
- Miss: "I hardly go outside, my bones ache all the time and I feel weak." true Endocrinology, predicted General Medicine
- Miss: "It stings when I urinate and I feel like I need to go all the time." true Obstetrics and Gynecology, predicted General Medicine
- Miss: "My periods come every two or three months, I have acne and hair growing on my chin." true Obstetrics and Gynecology, predicted Endocrinology
