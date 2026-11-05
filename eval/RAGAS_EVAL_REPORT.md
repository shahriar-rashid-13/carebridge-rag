# RAGAS evaluation report (skeleton)

**Mode:** `offline`
**Scoring:** `offline_proxy_lexical`
**Golden set:** `eval/ragas-golden-set.json` (38 items)
**Run at:** 2026-11-05T08:10:24.210Z
**Real RAGAS?** **no** — offline lexical proxies / placeholder

## Aggregate (0–1)

| Metric | Score | Planned hard floor (tomorrow) |
|---|---:|---:|
| faithfulness | 0.5729 | 0.7 |
| answer_relevance | 0.3778 | 0.7 |
| context_precision | 0.5688 | 0.55 |
| context_recall | 0.5688 | 0.55 |

## By category

| Category | n | Faithfulness | Answer relevance | Context precision | Context recall |
|---|---:|---:|---:|---:|---:|
| matching | 10 | 0.7428 | 0.4260 | 0.7428 | 0.7428 |
| edge | 6 | 0.6939 | 0.4194 | 0.6939 | 0.6939 |
| noisy | 6 | 0.7184 | 0.3966 | 0.7184 | 0.7184 |
| policy | 6 | 0.1770 | 0.1471 | 0.1770 | 0.1770 |
| refusal | 5 | 0.6000 | 0.6000 | — | — |
| multi_hop | 5 | 0.3610 | 0.2636 | 0.3610 | 0.3610 |

## A3 baseline bridge

- Locked A3b (project store `docs/a3-rag-baseline.md`): Hit@5 / MRR / P@5 and 1–5 judge scores.
- Do **not** treat A3 faithfulness/relevance 5.00 as RAGAS 1.0.
- Live RAGAS tomorrow re-scores the same golden set; offline proxies above are **not** comparable to A3.

## How to fill real scores (tomorrow)

1. Set `LITELLM_BASE_URL` + `LITELLM_MASTER_KEY` (and RAG endpoint env as wired).
2. Run live mode: `node scripts/ragas-eval.mjs --mode live` (or `python scripts/ragas-eval-live.py` once wired).
3. Replace this report + `eval/ragas-results.json` with real RAGAS output.
4. Derive final CI hard floors from that live run; update `PLANNED_THRESHOLDS` / gate config.
5. Project-store mirror: `docs/a4-ragas-results.md` in the CareBridge agent store.

## Out of scope

- Langfuse (deferred).
- Hard CI fail on thresholds (soft-skip until secrets + live scores exist).
