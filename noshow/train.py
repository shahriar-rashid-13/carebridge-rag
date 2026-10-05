"""No-show prediction on the public Kaggle "Medical Appointment No Shows" dataset.

Usage: python noshow/train.py
Input: noshow/data/KaggleV2-May-2016.csv (download from Kaggle, not committed)
Output: noshow/results/metrics.json and noshow/results/tables.md
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "KaggleV2-May-2016.csv"
OUT = ROOT / "results"
SEED = 42

FEATURES = [
    "age",
    "is_female",
    "lead_days",
    "same_day",
    "weekday",
    "scholarship",
    "hypertension",
    "diabetes",
    "alcoholism",
    "handicap",
    "sms_received",
    "prior_appointments",
    "prior_no_shows",
    "prior_no_show_rate",
]


def load() -> tuple[pd.DataFrame, dict]:
    raw = pd.read_csv(DATA)
    df = pd.DataFrame(
        {
            "patient": raw["PatientId"].astype("int64"),
            "scheduled": pd.to_datetime(raw["ScheduledDay"]).dt.tz_localize(None),
            "day": pd.to_datetime(raw["AppointmentDay"]).dt.tz_localize(None).dt.normalize(),
            "age": raw["Age"],
            "is_female": (raw["Gender"] == "F").astype(int),
            "scholarship": raw["Scholarship"],
            "hypertension": raw["Hipertension"],
            "diabetes": raw["Diabetes"],
            "alcoholism": raw["Alcoholism"],
            "handicap": (raw["Handcap"] > 0).astype(int),
            "sms_received": raw["SMS_received"],
            "no_show": (raw["No-show"] == "Yes").astype(int),
        }
    )
    df["lead_days"] = (df["day"] - df["scheduled"].dt.normalize()).dt.days

    cleaning = {"raw_rows": len(df)}
    bad_age = (df["age"] < 0) | (df["age"] > 110)
    bad_lead = df["lead_days"] < 0
    cleaning["dropped_bad_age"] = int(bad_age.sum())
    cleaning["dropped_negative_lead_time"] = int((bad_lead & ~bad_age).sum())
    df = df[~bad_age & ~bad_lead].copy()
    cleaning["clean_rows"] = len(df)

    df["same_day"] = (df["lead_days"] == 0).astype(int)
    df["weekday"] = df["day"].dt.weekday

    # History uses only appointments on earlier days. Outcomes from the same day
    # are not known when the prediction is made, so they must not leak in.
    per_day = (
        df.groupby(["patient", "day"])["no_show"]
        .agg(appointments="size", no_shows="sum")
        .reset_index()
        .sort_values(["patient", "day"])
    )
    grouped = per_day.groupby("patient")
    per_day["prior_appointments"] = grouped["appointments"].cumsum() - per_day["appointments"]
    per_day["prior_no_shows"] = grouped["no_shows"].cumsum() - per_day["no_shows"]
    df = df.merge(
        per_day[["patient", "day", "prior_appointments", "prior_no_shows"]],
        on=["patient", "day"],
        how="left",
    )
    df["prior_no_show_rate"] = np.where(
        df["prior_appointments"] > 0, df["prior_no_shows"] / df["prior_appointments"].clip(lower=1), 0.0
    )
    return df, cleaning


def time_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    days = np.sort(df["day"].unique())
    counts = df.groupby("day").size().reindex(days).cumsum() / len(df)
    val_start = days[np.searchsorted(counts.values, 0.6)]
    test_start = days[np.searchsorted(counts.values, 0.8)]
    train = df[df["day"] < val_start]
    val = df[(df["day"] >= val_start) & (df["day"] < test_start)]
    test = df[df["day"] >= test_start]
    info = {
        "train": {"rows": len(train), "from": str(train["day"].min().date()), "to": str(train["day"].max().date()), "no_show_rate": round(train["no_show"].mean(), 4)},
        "validation": {"rows": len(val), "from": str(val["day"].min().date()), "to": str(val["day"].max().date()), "no_show_rate": round(val["no_show"].mean(), 4)},
        "test": {"rows": len(test), "from": str(test["day"].min().date()), "to": str(test["day"].max().date()), "no_show_rate": round(test["no_show"].mean(), 4)},
    }
    return train, val, test, info


def best_f1_threshold(y: np.ndarray, scores: np.ndarray) -> float:
    precision, recall, thresholds = precision_recall_curve(y, scores)
    f1 = 2 * precision * recall / np.maximum(precision + recall, 1e-12)
    return float(thresholds[int(np.argmax(f1[:-1]))])


def evaluate(y: np.ndarray, flags: np.ndarray, scores: np.ndarray | None) -> dict:
    tn, fp, fn, tp = confusion_matrix(y, flags, labels=[0, 1]).ravel()
    result = {
        "accuracy": accuracy_score(y, flags),
        "precision": precision_score(y, flags, zero_division=0),
        "recall": recall_score(y, flags, zero_division=0),
        "f1": f1_score(y, flags, zero_division=0),
        "pr_auc": average_precision_score(y, scores) if scores is not None else None,
        "roc_auc": roc_auc_score(y, scores) if scores is not None else None,
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "flagged_share": float(flags.mean()),
    }
    return {k: (round(float(v), 4) if isinstance(v, (float, np.floating)) else v) for k, v in result.items()}


def models() -> dict:
    return {
        "logistic_regression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "gradient_boosting": HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, max_leaf_nodes=31, l2_regularization=1.0, random_state=SEED
        ),
    }


def main() -> None:
    df, cleaning = load()
    train, val, test, split = time_split(df)
    y_val = val["no_show"].to_numpy()
    y_test = test["no_show"].to_numpy()
    results: dict = {"cleaning": cleaning, "split": split, "features": FEATURES, "models": {}}

    results["models"]["baseline_nobody"] = {
        "description": "Predict that nobody no-shows",
        "test": evaluate(y_test, np.zeros_like(y_test), None),
    }
    prior_flag = (test["prior_no_shows"] > 0).to_numpy().astype(int)
    results["models"]["baseline_prior_no_show"] = {
        "description": "Flag patients with at least one earlier no-show",
        "test": evaluate(y_test, prior_flag, None),
    }

    importances: dict = {}
    for name, model in models().items():
        model.fit(train[FEATURES], train["no_show"])
        threshold = best_f1_threshold(y_val, model.predict_proba(val[FEATURES])[:, 1])

        # Refit on train + validation, keep the threshold chosen on validation.
        final = models()[name]
        fit_rows = pd.concat([train, val])
        final.fit(fit_rows[FEATURES], fit_rows["no_show"])
        scores = final.predict_proba(test[FEATURES])[:, 1]
        results["models"][name] = {
            "threshold": round(threshold, 4),
            "test_at_0_5": evaluate(y_test, (scores >= 0.5).astype(int), scores),
            "test_at_tuned": evaluate(y_test, (scores >= threshold).astype(int), scores),
        }
        perm = permutation_importance(
            final, test[FEATURES], y_test, scoring="average_precision", n_repeats=5, random_state=SEED
        )
        importances[name] = sorted(
            ({"feature": f, "pr_auc_drop": round(float(m), 4)} for f, m in zip(FEATURES, perm.importances_mean)),
            key=lambda r: r["pr_auc_drop"],
            reverse=True,
        )
    results["permutation_importance"] = importances

    OUT.mkdir(exist_ok=True)
    (OUT / "metrics.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    (OUT / "tables.md").write_text(tables(results), encoding="utf-8")
    print(tables(results))


def tables(r: dict) -> str:
    lines = ["| Model | Threshold | Accuracy | Precision | Recall | F1 | PR-AUC | ROC-AUC | Flagged |", "|---|---|---|---|---|---|---|---|---|"]
    rows = [
        ("Baseline: nobody no-shows", "-", r["models"]["baseline_nobody"]["test"]),
        ("Baseline: earlier no-show", "-", r["models"]["baseline_prior_no_show"]["test"]),
    ]
    for key, label in (("logistic_regression", "Logistic regression"), ("gradient_boosting", "Gradient boosting")):
        m = r["models"][key]
        rows.append((f"{label} (0.5)", "0.5", m["test_at_0_5"]))
        rows.append((f"{label} (tuned)", str(m["threshold"]), m["test_at_tuned"]))
    for label, threshold, t in rows:
        fmt = lambda v: "-" if v is None else f"{v:.3f}"
        lines.append(
            f"| {label} | {threshold} | {fmt(t['accuracy'])} | {fmt(t['precision'])} | {fmt(t['recall'])} | {fmt(t['f1'])} | {fmt(t['pr_auc'])} | {fmt(t['roc_auc'])} | {t['flagged_share']:.1%} |"
        )
    lines += ["", "Confusion matrices on the test set (rows: actual, columns: predicted):", ""]
    for label, _, t in rows:
        c = t["confusion"]
        lines += [
            f"**{label}**",
            "",
            "| | Predicted show | Predicted no-show |",
            "|---|---|---|",
            f"| Actual show | {c['tn']} | {c['fp']} |",
            f"| Actual no-show | {c['fn']} | {c['tp']} |",
            "",
        ]
    lines += ["Permutation importance (drop in PR-AUC on the test set, gradient boosting):", "", "| Feature | PR-AUC drop |", "|---|---|"]
    lines += [f"| {i['feature']} | {i['pr_auc_drop']:.4f} |" for i in r["permutation_importance"]["gradient_boosting"]]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
