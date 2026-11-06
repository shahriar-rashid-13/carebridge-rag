# RAGAS evaluation report

**Mode:** `live`
**Scoring:** `litellm_judge_ragas_aligned_0_1`
**Golden set:** `eval/ragas-golden-set.json` (38 items)
**Run at:** 2026-11-06T06:32:54.727Z
**Real RAGAS?** **yes** — litellm_judge_ragas_aligned_0_1

## Aggregate (0–1)

| Metric | Score | Hard floor |
|---|---:|---:|
| faithfulness | 1.0000 | 0.7 |
| answer_relevance | 0.9579 | 0.7 |
| context_precision | 0.8376 | 0.55 |
| context_recall | 0.9853 | 0.55 |

## By category

| Category | n | Faithfulness | Answer relevance | Context precision | Context recall |
|---|---:|---:|---:|---:|---:|
| matching | 10 | 1.0000 | 1.0000 | 0.7357 | 1.0000 |
| edge | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| noisy | 6 | 1.0000 | 1.0000 | 0.8000 | 1.0000 |
| policy | 6 | 1.0000 | 1.0000 | 0.9633 | 0.9167 |
| refusal | 5 | 1.0000 | 1.0000 | — | — |
| multi_hop | 5 | 1.0000 | 0.6800 | — | — |

## Refusal

- Correct refuse rate: **1** (5/5)
- False answer rate: **0**

## A3 baseline bridge

- Locked A3b: matching Hit@5/MRR/P@5 = 1.00 / 1.00 / 0.63; edge 0.92 / 0.92 / 0.62; noisy 0.90 / 0.90 / 0.57.
- A3 judge faithfulness/relevance 5.00 / 5.00 on matching is **1–5 scale**, not RAGAS 0–1.
- Live RAGAS re-scores the same golden families; do not equate 5 → 1.

## Notes

- System under test: agentic RAG (plan → multi-hop hybrid retrieve → refuse) via live Supabase + LiteLLM.
- Judge model: `carebridge-judge` through LiteLLM (RAGAS-aligned 0–1 prompts).
- Langfuse: see clinic-flow A4 docs when wired.
