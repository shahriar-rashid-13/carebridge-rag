# CareBridge search evaluation for AI v3

Run: 2026-10-08T07:44:59.055Z · k = 5 · clean index (no noise rows), the setting the app uses.

Variants:

- **A2**: Assessment 2 search, gemini-embedding-001 on 1,960 rows (FAQ and prescriptions), hybrid search. From `RAG_EVAL_REPORT.md`.
- **A3a**: gte-small on all 20,758 rows, hybrid search. From `RAG_EVAL_REPORT_GTE.md` (k = 5) and re-run here with 20 candidates as v3 does.
- **A3b**: A3a with 20 candidates re-ranked to 5 by the app model (`carebridge-agent`, Gemini 3.1 Flash Lite), same prompt as v3. The eval allows 20 s per re-rank (production: 6 s, then the fused order), so the gateway can retry on the second Gemini key.
- **Dense only**: both embedding models on the same 1960 rows with cosine search only, to separate the model from corpus size.
- **A3c**: policy questions answered from search results only vs from the approved OKF policy file.

Judge: `carebridge-judge` (Gemini 3.5 Flash), a different model from the answer model.

## 1. Retrieval: A2 vs A3a vs A3b

| Variant | Set | Queries | Hit@5 | MRR | P@5 |
|---|---|---|---|---|---|
| A2 Gemini, 1,960 rows (k = 5) | matching | 30 | 1.00 | 1.00 | 0.47 |
| A2 Gemini, 1,960 rows (k = 5) | edge | 25 | 0.96 | 0.94 | 0.54 |
| A2 Gemini, 1,960 rows (k = 5) | noisy | 30 | 0.97 | 0.97 | 0.45 |
| A3a gte-small, 20,758 rows (k = 5) | matching | 30 | 1.00 | 0.97 | 0.56 |
| A3a gte-small, 20,758 rows (k = 5) | edge | 25 | 0.88 | 0.88 | 0.62 |
| A3a gte-small, 20,758 rows (k = 5) | noisy | 30 | 0.87 | 0.79 | 0.49 |
| A3a fused (20 to 5) | matching | 30 | 1.00 | 0.93 | 0.60 |
| A3b re-ranked (20 to 5) | matching | 30 | 1.00 | 1.00 | 0.63 |
| A3a fused (20 to 5) | edge | 25 | 0.88 | 0.88 | 0.62 |
| A3b re-ranked (20 to 5) | edge | 25 | 0.92 | 0.92 | 0.62 |
| A3a fused (20 to 5) | noisy | 30 | 0.87 | 0.80 | 0.51 |
| A3b re-ranked (20 to 5) | noisy | 30 | 0.90 | 0.90 | 0.57 |

Re-rank fallbacks to the fused order (timeout or invalid reply): matching 0, edge 3, noisy 1.

Out-of-scope queries returning nothing (20 candidates): A3a fused (20 to 5) 5 of 5; A3b re-ranked (20 to 5) 5 of 5.

## 2. Dense only on the same 1960 rows

| Model | Set | Queries | Hit@5 | MRR | P@5 |
|---|---|---|---|---|---|
| gemini-embedding-001 | matching | 30 | 1.00 | 0.95 | 0.47 |
| gemini-embedding-001 | edge | 25 | 1.00 | 1.00 | 0.57 |
| gemini-embedding-001 | noisy | 30 | 1.00 | 0.93 | 0.48 |
| gte-small | matching | 30 | 1.00 | 0.98 | 0.48 |
| gte-small | edge | 25 | 0.92 | 0.92 | 0.50 |
| gte-small | noisy | 30 | 0.90 | 0.88 | 0.38 |

## 3. Judged answers (30 matching queries)

| Variant | Judged | Faithfulness (1-5) | Relevance (1-5) |
|---|---|---|---|
| A2 | 30 | 5.00 | 5.00 |
| A3b | 30 | 5.00 | 5.00 |

## 4. A3c: policy questions, RAG only vs OKF

| Variant | Judged | Correctness (1-5) | Fully correct | Contradicts policy |
|---|---|---|---|---|
| RAG only | 14 | 3.14 | 6 | 5 |
| OKF | 15 | 4.73 | 14 | 1 |

The keyword router (`findOkf`, used when the supervisor model fails) picked the right policy file for 1 of 15 paraphrased questions. With the supervisor model, policy routing is measured in the agent evaluation.

Answers that contradict the policy:

- P01 RAG only: "Is the clinic open on Fridays?" (The answer incorrectly claims the policy does not state the clinic's hours, whereas the policy explicitly states that the clinic is closed on Fridays.)
- P09 RAG only: "How do I get more of the medicine my doctor prescribed?" (The assistant incorrectly claims the text lacks information on obtaining refills, directly contradicting the policy which states that patients must book a follow-up appointment to renew a prescription.)
- P12 RAG only: "Why do some doctors charge more than others?" (The assistant incorrectly states that the policy does not explain the fee difference, whereas the policy explicitly states that senior consultants charge more.)
- P13 RAG only: "How do I stop the reminder emails?" (The assistant incorrectly states that the policy does not contain information on how to stop reminder emails, which is directly addressed in the 'Stopping emails' section.)
- P13 OKF: "How do I stop the reminder emails?" (The answer incorrectly claims that the policy does not specify how to stop appointment reminder emails, which directly contradicts the text's instructions to tick the checkbox on the unsubscribe page or contact reception.)
- P15 RAG only: "Is my appointment confirmed as soon as I book it?" (The answer contradicts the policy by stating reception confirms bookings within the same working day (omitting 'or the next') and by inventing working days (Saturday through Thursday) not mentioned in the text.)

## Re-rank changes (matching set)

- M01 reranked: fused FAQ-000001*, FAQ-000003, FAQ-000017, FAQ-000033 / re-ranked FAQ-000001*
- M02 reranked: fused FAQ-000002*, FAQ-000001, FAQ-000003 / re-ranked FAQ-000002*, FAQ-000001
- M03 reranked: fused FAQ-000009*, FAQ-000010, FAQ-000116, FAQ-000024, FAQ-000118 / re-ranked FAQ-000009*, FAQ-000010, FAQ-000011, FAQ-000056, FAQ-000012
- M04 reranked: fused FAQ-000013*, FAQ-000009, FAQ-000022, FAQ-000025, FAQ-000014 / re-ranked FAQ-000013*, FAQ-000009, FAQ-000022, FAQ-000025, FAQ-000021
- M05 reranked: fused FAQ-000021*, FAQ-000022*, FAQ-000016, FAQ-000026, FAQ-000012 / re-ranked FAQ-000021*, FAQ-000066, FAQ-000022*, FAQ-000026, FAQ-000024
- M06 reranked: fused FAQ-000026, FAQ-000024*, FAQ-000025*, FAQ-000021, FAQ-000012 / re-ranked FAQ-000024*, FAQ-000025*, FAQ-000026, FAQ-000021, FAQ-000022
- M07 reranked: fused FAQ-000028*, FAQ-000021, FAQ-000026, FAQ-000022, FAQ-000024 / re-ranked FAQ-000028*, FAQ-000027*
- M08 reranked: fused FAQ-000033, FAQ-000029*, FAQ-000030*, FAQ-000032, FAQ-000016 / re-ranked FAQ-000029*, FAQ-000032, FAQ-000030*, FAQ-000039, FAQ-000031
- M09 reranked: fused FAQ-000032*, FAQ-000033, FAQ-000039, FAQ-000029, FAQ-000030 / re-ranked FAQ-000032*, FAQ-000039, FAQ-000033
- M11 reranked: fused FAQ-000049*, FAQ-000005, FAQ-000053 / re-ranked FAQ-000049*
- M12 reranked: fused FAQ-000053, FAQ-000057* / re-ranked FAQ-000057*
- M13 reranked: fused FAQ-000067*, FAQ-000011, FAQ-000046, FAQ-000066, FAQ-000073 / re-ranked FAQ-000067*, FAQ-000046, FAQ-000011, FAQ-000073, FAQ-000115
- M14 reranked: fused FAQ-000065*, VN-001712, VN-005097, VN-003895, RX-007230 / re-ranked FAQ-000065*, VN-002444
- M15 reranked: fused FAQ-000240*, VN-007022, VN-006131, VN-006437, VN-006440 / re-ranked FAQ-000240*, FAQ-000019, FAQ-000077, FAQ-000010, VN-007022
- M16 reranked: fused VN-002136, VN-002963*, VN-009356*, VN-002222, VN-003909* / re-ranked VN-002963*, VN-009356*, VN-008875*, VN-005491*, VN-006099*
- M17 reranked: fused VN-009633*, VN-003691*, VN-005843*, VN-005789*, VN-004821* / re-ranked VN-005843*, VN-008761*, VN-009597*, VN-009331*, VN-005975*
- M19 reranked: fused VN-007880*, VN-010041*, VN-005122*, VN-009144*, VN-005564 / re-ranked VN-010041*, VN-005122*, VN-000228*, VN-007880*, VN-005781*
- M20 reranked: fused VN-007770*, VN-005043*, VN-002474*, VN-003043*, VN-006908* / re-ranked VN-004984*, VN-008004*, VN-005752*, VN-008961*, VN-007533*
- M21 reranked: fused VN-002414*, VN-001441*, VN-000338*, VN-002716*, VN-002571* / re-ranked VN-000338*, VN-002716*, VN-004393*, VN-004193*, VN-001523*
- M22 reranked: fused VN-009741*, VN-000343*, VN-003981*, VN-001863*, VN-002703* / re-ranked VN-009368*, VN-009741*, VN-001863*, VN-002703*, VN-005455*
- M23 reranked: fused VN-008230*, VN-009239*, VN-005915*, VN-003902*, VN-004461* / re-ranked FAQ-000106*, VN-004461*, VN-006485*, VN-005915*, VN-002767*
- M24 reranked: fused VN-002317*, VN-000259*, VN-009380*, VN-005114*, VN-009910* / re-ranked VN-009910*, VN-002859*, VN-000357*, VN-000939*, VN-009488*
- M25 reranked: fused VN-000225*, VN-002188*, VN-003227*, VN-008840*, VN-008255* / re-ranked VN-008369*, VN-002033*, VN-003884*, VN-007994*, VN-002201*
- M30 reranked: fused RX-007460*, RX-004442*, RX-007246*, RX-003814*, RX-007250* / re-ranked RX-005936*, RX-003135*, RX-007460*, RX-004442*, RX-007246*
