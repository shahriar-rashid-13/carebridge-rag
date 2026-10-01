"""Track 4: predict the specialization to book from a symptom description.

Data: the 2,580 synthetic visit notes in corpus/corpus_clean.jsonl. The input text is the patient's
complaint and history only (between the patient header and "On examination"), with names removed,
so the model never sees the doctor, the specialization, the findings, or the diagnosis.

Split: stratified 80/20, random_state 42. Model: TF-IDF (word 1-2 grams) + logistic regression.
Extra check: the 48 "Symptom routing" FAQ questions, a different writing style, as an outside test.

Usage: .venv/Scripts/python scripts/classify-eval.py
Writes eval/classification-results.json, eval/CLASSIFICATION_REPORT.md and
eval/.cache/classify-test.json (the held-out set, used by scripts/classify-llm.mjs).
"""

import json
import random
import re
from pathlib import Path

import numpy as np
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedGroupKFold, cross_val_score
from sklearn.pipeline import make_pipeline

ROOT = Path(__file__).resolve().parent.parent
EVAL = ROOT / "eval"
SEED = 42

SPECIALIZATIONS = [
    "General Medicine", "Cardiology", "Pulmonology", "Gastroenterology", "Endocrinology", "Dermatology",
    "Orthopedics", "Neurology", "ENT", "Ophthalmology", "Obstetrics and Gynecology", "Psychiatry",
]
SHORT = {
    "General Medicine": "GenMed", "Cardiology": "Cardio", "Pulmonology": "Pulmo", "Gastroenterology": "Gastro",
    "Endocrinology": "Endo", "Dermatology": "Derm", "Orthopedics": "Ortho", "Neurology": "Neuro", "ENT": "ENT",
    "Ophthalmology": "Ophth", "Obstetrics and Gynecology": "ObGyn", "Psychiatry": "Psych",
}


def symptom_text(record):
    text = record["content"]
    start = re.search(r"Patient: [^.]*\.\s*", text)
    end = text.find(" On examination")
    body = text[start.end() if start else 0 : end if end > 0 else len(text)]
    body = re.sub(r"\b(Mr|Mrs|Ms|Miss)\.? [A-Z][a-z]+", "The patient", body)
    for part in (record.get("patient_name") or "").split():
        body = re.sub(rf"\b{re.escape(part)}\b", "the patient", body)
    return body.strip()


def first_sentence(text):
    return re.split(r"(?<=\.)\s", text, maxsplit=1)[0]


def add_typos(rand, text, rate=0.3):
    words = text.split()
    for k, w in enumerate(words):
        if len(w) >= 4 and rand.random() < rate:
            i = rand.randrange(1, len(w) - 1)
            words[k] = w[:i] + w[i + 1 :] if rand.random() < 0.5 else w[:i] + w[i + 1] + w[i] + w[i + 2 :]
    return " ".join(words)


def routing_label(answer):
    hits = [s for s in SPECIALIZATIONS if re.search(rf"\b{re.escape(s)}\b", answer)]
    return hits[0] if len(hits) == 1 else None


def main():
    records = [json.loads(line) for line in (ROOT / "corpus" / "corpus_clean.jsonl").read_text("utf8").splitlines() if line]
    notes = [r for r in records if r["record_type"] == "visit_note"]
    texts = [symptom_text(r) for r in notes]
    labels = [r["specialization"] for r in notes]
    diagnoses = [r["diagnosis"] for r in notes]
    difficulty = [r["difficulty"] for r in notes]
    idx = np.arange(len(notes))

    # Follow-up notes repeat the first visit's story, so all notes of one patient stay on one side.
    groups = [r["synthetic_patient_ref"] for r in notes]
    splitter = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED)
    train_idx, test_idx = next(splitter.split(idx, labels, groups))
    x_train = [texts[i] for i in train_idx]
    x_test = [texts[i] for i in test_idx]
    rand = random.Random(SEED)
    x_stress = [add_typos(rand, first_sentence(t)) for t in x_test]

    def model():
        return make_pipeline(
            TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=2, stop_words="english"),
            LogisticRegression(max_iter=3000, C=10, class_weight="balanced"),
        )

    results = {"data": {"records": len(notes), "train": len(train_idx), "test": len(test_idx), "classes": len(set(labels))}}

    for task, y in (("specialization", labels), ("diagnosis", diagnoses)):
        y_train = [y[i] for i in train_idx]
        y_test = [y[i] for i in test_idx]
        baseline = DummyClassifier(strategy="most_frequent").fit(x_train, y_train)
        clf = model().fit(x_train, y_train)
        pred = clf.predict(x_test)
        cv = cross_val_score(
            model(), x_train, y_train, groups=[groups[i] for i in train_idx],
            cv=StratifiedGroupKFold(5, shuffle=True, random_state=SEED), scoring="accuracy",
        )
        entry = {
            "classes": len(set(y)),
            "baseline_accuracy": accuracy_score(y_test, baseline.predict(x_test)),
            "accuracy": accuracy_score(y_test, pred),
            "stress_accuracy": accuracy_score(y_test, clf.predict(x_stress)),
            "macro_f1": f1_score(y_test, pred, average="macro"),
            "cv5_accuracy_mean": float(cv.mean()),
            "cv5_accuracy_std": float(cv.std()),
        }
        if task == "specialization":
            entry["per_class"] = classification_report(y_test, pred, labels=SPECIALIZATIONS, output_dict=True, zero_division=0)
            entry["confusion_matrix"] = confusion_matrix(y_test, pred, labels=SPECIALIZATIONS).tolist()
            by_diff = {}
            for d in sorted(set(difficulty)):
                sel = [k for k, i in enumerate(test_idx) if difficulty[i] == d]
                by_diff[d] = {"n": len(sel), "accuracy": accuracy_score([y_test[k] for k in sel], [pred[k] for k in sel])}
            entry["accuracy_by_difficulty"] = by_diff
            entry["errors"] = [
                {"doc_id": notes[i]["doc_id"], "true": y_test[k], "predicted": pred[k], "text": x_test[k][:220]}
                for k, i in enumerate(test_idx)
                if pred[k] != y_test[k]
            ][:10]

            routing = [r for r in records if r["record_type"] == "faq" and r.get("faq_topic") == "Symptom routing"]
            pairs = []
            for r in routing:
                q, _, a = r["content"].partition(" A: ")
                label = routing_label(a)
                if label:
                    pairs.append((q.removeprefix("Q: "), label))
            if pairs:
                routing_pred = clf.predict([q for q, _ in pairs])
                entry["outside_test_symptom_faq"] = {
                    "n": len(pairs),
                    "accuracy": accuracy_score([l for _, l in pairs], routing_pred),
                }
            lay = json.loads((EVAL / "symptom-queries.json").read_text("utf8"))["items"]
            lay_pred = clf.predict([item["text"] for item in lay])
            entry["outside_test_handwritten"] = {
                "n": len(lay),
                "accuracy": accuracy_score([item["label"] for item in lay], lay_pred),
                "errors": [
                    {"text": item["text"], "true": item["label"], "predicted": p}
                    for item, p in zip(lay, lay_pred)
                    if p != item["label"]
                ],
            }
            (EVAL / ".cache").mkdir(parents=True, exist_ok=True)
            (EVAL / ".cache" / "classify-test.json").write_text(
                json.dumps(
                    [
                        {"doc_id": notes[i]["doc_id"], "text": texts[i], "stress_text": x_stress[k], "label": labels[i], "difficulty": difficulty[i]}
                        for k, i in enumerate(test_idx)
                    ],
                    indent=1,
                ),
                "utf8",
            )
        results[task] = entry
        print(f"{task}: accuracy {entry['accuracy']:.3f}, stress {entry['stress_accuracy']:.3f} (baseline {entry['baseline_accuracy']:.3f}), macro F1 {entry['macro_f1']:.3f}, 5-fold CV {entry['cv5_accuracy_mean']:.3f} ± {entry['cv5_accuracy_std']:.3f}")

    if "outside_test_symptom_faq" in results["specialization"]:
        o = results["specialization"]["outside_test_symptom_faq"]
        print(f"symptom FAQ outside test: {o['accuracy']:.3f} on {o['n']} questions")
    h = results["specialization"]["outside_test_handwritten"]
    print(f"hand-written outside test: {h['accuracy']:.3f} on {h['n']} descriptions")

    (EVAL / "classification-results.json").write_text(json.dumps(results, indent=2), "utf8")
    (EVAL / "CLASSIFICATION_REPORT.md").write_text(report(results), "utf8")
    print("Wrote eval/classification-results.json and eval/CLASSIFICATION_REPORT.md")


def report(r):
    s, d = r["specialization"], r["diagnosis"]
    lines = [
        "# CareBridge classification: specialization from symptoms",
        "",
        f"Data: {r['data']['records']} synthetic visit notes. Input: complaint and history only (no doctor, specialization, findings, or diagnosis; names removed).",
        f"Split: about 80/20, stratified by label and grouped by patient so a patient's follow-up notes never appear on both sides (train {r['data']['train']}, held-out test {r['data']['test']}), random_state {SEED}.",
        "Model: TF-IDF (word 1-2 grams, sublinear tf, English stop words) + logistic regression (C=10, balanced class weights), scikit-learn.",
        "Stress test: the same held-out notes cut to the first sentence (the chief complaint only) with typos in about 30% of longer words.",
        "",
        "| Task | Classes | Majority baseline | Held-out accuracy | Stress test accuracy | Macro F1 | 5-fold grouped CV (train) |",
        "|---|---|---|---|---|---|---|",
        f"| Specialization | {s['classes']} | {s['baseline_accuracy']:.1%} | **{s['accuracy']:.1%}** | {s['stress_accuracy']:.1%} | {s['macro_f1']:.3f} | {s['cv5_accuracy_mean']:.1%} ± {s['cv5_accuracy_std']:.1%} |",
        f"| Diagnosis (harder, extra) | {d['classes']} | {d['baseline_accuracy']:.1%} | **{d['accuracy']:.1%}** | {d['stress_accuracy']:.1%} | {d['macro_f1']:.3f} | {d['cv5_accuracy_mean']:.1%} ± {d['cv5_accuracy_std']:.1%} |",
        "",
        f"Target: at least 70% held-out accuracy. Result: **{'PASS' if s['accuracy'] >= 0.7 else 'FAIL'}**.",
        "",
    ]
    if "outside_test_symptom_faq" in s:
        o = s["outside_test_symptom_faq"]
        lines += [f"Outside test 1: the {o['n']} \"Symptom routing\" FAQ questions (short first-person questions, never seen in training): {o['accuracy']:.1%} accuracy.", ""]
    h = s["outside_test_handwritten"]
    lines += [
        f"Outside test 2: {h['n']} hand-written lay descriptions in `eval/symptom-queries.json` (4 per specialization, different wording from the corpus): {h['accuracy']:.1%} accuracy.",
        "",
    ]
    lines += [f"- Miss: \"{e['text']}\" true {e['true']}, predicted {e['predicted']}" for e in h["errors"]]
    lines.append("")
    lines += ["Accuracy by record difficulty (held-out set):", "", "| Difficulty | n | Accuracy |", "|---|---|---|"]
    lines += [f"| {k} | {v['n']} | {v['accuracy']:.1%} |" for k, v in s["accuracy_by_difficulty"].items()]
    lines += ["", "Per-class results (specialization):", "", "| Specialization | Precision | Recall | F1 | Support |", "|---|---|---|---|---|"]
    for name in SPECIALIZATIONS:
        c = s["per_class"][name]
        lines.append(f"| {name} | {c['precision']:.2f} | {c['recall']:.2f} | {c['f1-score']:.2f} | {int(c['support'])} |")
    lines += ["", "Confusion matrix (rows = true, columns = predicted):", ""]
    lines.append("| | " + " | ".join(SHORT[n] for n in SPECIALIZATIONS) + " |")
    lines.append("|---" * (len(SPECIALIZATIONS) + 1) + "|")
    for name, row in zip(SPECIALIZATIONS, s["confusion_matrix"]):
        lines.append(f"| **{SHORT[name]}** | " + " | ".join(str(v) if v else "·" for v in row) + " |")
    lines += ["", "Held-out errors (first 10):", ""]
    lines += [f"- {e['doc_id']}: true {e['true']}, predicted {e['predicted']}. \"{e['text']}...\"" for e in s["errors"]] or ["- none"]
    llm_file = EVAL / "classification-llm-results.json"
    if llm_file.exists():
        llm = json.loads(llm_file.read_text("utf8"))
        lines += [
            "",
            "## LLM classifier (zero-shot)",
            "",
            f"Model: {llm['model']}. Produced by `scripts/classify-llm.mjs`, run {llm['run_at']}.",
            "",
            "| Test set | n | Accuracy |",
            "|---|---|---|",
            f"| Hand-written lay descriptions | {llm['handwritten']['n']} | {llm['handwritten']['accuracy']:.1%} |",
            f"| Held-out notes, stress form (10 per class) | {llm['held_out_stress_sample']['n']} | {llm['held_out_stress_sample']['accuracy']:.1%} |",
            "",
        ]
        lines += [f"- Miss: \"{e['text']}\" true {e['true']}, predicted {e['predicted']}" for e in llm["handwritten"]["errors"]]
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
