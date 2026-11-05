#!/usr/bin/env python3
"""
Assessment 4 Option 1 — Live RAGAS eval skeleton (tomorrow).

This file documents the live path. It does NOT call Langfuse.
Offline CI today uses: node scripts/ragas-eval.mjs --mode offline

Tomorrow wiring checklist:
  1. pip install -r requirements-ragas.txt
  2. Export LITELLM_BASE_URL + LITELLM_MASTER_KEY
  3. For each item in eval/ragas-golden-set.json, call the live agentic RAG
     path → answer + retrieved contexts (refusal when expect_refuse)
  4. Build a HuggingFace Dataset with columns:
       question, answer, contexts, ground_truth
  5. ragas.evaluate(... metrics=[faithfulness, answer_relevancy,
       context_precision, context_recall]) via LiteLLM OpenAI-compatible LLM
  6. Write eval/ragas-results.json with real_ragas=true and refresh
     eval/RAGAS_EVAL_REPORT.md + project-store docs/a4-ragas-results.md

Run today (expected): exits 2 explaining secrets / not-wired.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "eval" / "ragas-golden-set.json"
RESULTS = ROOT / "eval" / "ragas-results.json"

METRICS = [
    "faithfulness",
    "answer_relevance",  # ragas package name: answer_relevancy
    "context_precision",
    "context_recall",
]


def load_dotenv_keys() -> dict[str, str]:
    env_path = ROOT / ".env"
    out: dict[str, str] = {}
    if not env_path.exists():
        return out
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip("\"'")
    return out


def main() -> int:
    file_env = load_dotenv_keys()
    key = os.environ.get("LITELLM_MASTER_KEY") or file_env.get("LITELLM_MASTER_KEY")
    base = os.environ.get("LITELLM_BASE_URL") or file_env.get("LITELLM_BASE_URL")

    if not GOLDEN.exists():
        print(f"Missing golden set: {GOLDEN}", file=sys.stderr)
        return 1

    golden = json.loads(GOLDEN.read_text())
    n = len(golden.get("items") or [])
    print(f"Golden set loaded: {n} items from {GOLDEN.relative_to(ROOT)}")
    print(f"Target metrics: {', '.join(METRICS)}")
    print(f"LITELLM_BASE_URL={'set' if base else 'MISSING'}")
    print(f"LITELLM_MASTER_KEY={'set' if key else 'MISSING'}")

    if not key:
        print(
            "Live RAGAS needs LITELLM_MASTER_KEY. "
            "Use offline harness today: node scripts/ragas-eval.mjs --mode offline",
            file=sys.stderr,
        )
        return 2

    # Secrets present but live RAG + ragas scoring not wired yet.
    print(
        "Secrets detected, but live RAGAS scoring is not wired in this skeleton.\n"
        "Tomorrow: retrieve answers via agentic RAG, then:\n"
        "  from ragas import evaluate\n"
        "  from ragas.metrics import faithfulness, answer_relevancy, "
        "context_precision, context_recall\n"
        "  result = evaluate(dataset, metrics=[...], llm=<LiteLLM OpenAI wrapper>)\n"
        f"Write real scores to {RESULTS.relative_to(ROOT)} with real_ragas=true.\n"
        "Langfuse is out of scope for this step.",
        file=sys.stderr,
    )
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
