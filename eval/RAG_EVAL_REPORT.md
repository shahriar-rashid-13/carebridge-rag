# CareBridge RAG evaluation

Run: 2026-10-01T03:44:49.284Z · k = 5 · gemini-embedding-001 (768 dims) via LiteLLM carebridge-embed

Search: match_rag_documents: cosine >= 0.55 or trigram >= 0.6, fused with full text by reciprocal rank fusion.

Index: 1960 clean embedded rows (FAQ and prescriptions) plus 300 noise rows
(100 typo duplicates of real records, 100 junk rows, 100 off-topic rows).
"clean" excludes noise rows (`include_noise = false`, what the app uses); "with_noise" includes them.

Metrics (answerable queries only):

- hit_rate: share of queries with at least one relevant result in the top 5.
- mrr: mean reciprocal rank of the first relevant result.
- p@5: relevant results in the top 5 divided by 5. Single-answer FAQ queries can score at most 0.2 to 0.4.
- noise: share of top-5 slots taken by noise rows.

| Set | Mode | Index | Queries | Hit rate | MRR | P@5 | Noise in top 5 |
|---|---|---|---|---|---|---|---|
| matching | hybrid | clean | 30 | 1.00 | 1.00 | 0.47 | 0.00 |
| matching | hybrid | with_noise | 30 | 1.00 | 0.97 | 0.41 | 0.35 |
| matching | keyword_only | clean | 30 | 0.87 | 0.85 | 0.33 | 0.00 |
| matching | keyword_only | with_noise | 30 | 0.83 | 0.77 | 0.31 | 0.31 |
| edge | hybrid | clean | 25 | 0.96 | 0.94 | 0.54 | 0.00 |
| edge | hybrid | with_noise | 25 | 0.96 | 0.94 | 0.46 | 0.38 |
| edge | keyword_only | clean | 25 | 0.88 | 0.82 | 0.38 | 0.00 |
| edge | keyword_only | with_noise | 25 | 0.88 | 0.82 | 0.38 | 0.25 |
| noisy | hybrid | clean | 30 | 0.97 | 0.97 | 0.45 | 0.00 |
| noisy | hybrid | with_noise | 30 | 0.47 | 0.40 | 0.13 | 0.83 |
| noisy | keyword_only | clean | 30 | 0.83 | 0.77 | 0.28 | 0.00 |
| noisy | keyword_only | with_noise | 30 | 0.27 | 0.19 | 0.07 | 0.89 |

Out-of-scope queries (correct answer is no result):

| Mode | Index | Returned nothing |
|---|---|---|
| hybrid | clean | 5 of 5 |
| hybrid | with_noise | 3 of 5 |
| keyword_only | clean | 3 of 5 |
| keyword_only | with_noise | 3 of 5 |

Hybrid-mode misses (no relevant result in the top 5):

- edge/clean E09: "chest pain" returned RX-000605, RX-000077, RX-000712, RX-000174, RX-000063
- edge/with_noise E09: "chest pain" returned NOISE-0148, NOISE-0181, NOISE-0116, RX-000077, RX-000261
- noisy/clean N03: "Wht are the steps to bok hmm?? a doctor ~~ apopintment?" returned FAQ-000011, FAQ-000007, FAQ-000056, FAQ-000074, FAQ-000072
- noisy/with_noise N03: "Wht are the steps to bok hmm?? a doctor ~~ apopintment?" returned NOISE-0147, NOISE-0135, NOISE-0138, NOISE-0048, NOISE-0112
- noisy/with_noise N05: "How do I cancel ... my xD booking?" returned NOISE-0112, NOISE-0062, NOISE-0199, NOISE-0155, NOISE-0157
- noisy/with_noise N06: "qwe!! Can I moev my appointment plz to anothher dayy?" returned NOISE-0135, NOISE-0007, NOISE-0152, NOISE-0200, NOISE-0005
- noisy/with_noise N07: "lol What happesn if I miss my lol appointmrnt?" returned NOISE-0159, NOISE-0184, NOISE-0135, NOISE-0166, NOISE-0162
- noisy/with_noise N08: "How qwe!! @@ des the clinic waitlist wrok?" returned NOISE-0144, NOISE-0155, NOISE-0157, NOISE-0198, NOISE-0119
- noisy/with_noise N11: "How can 1234 I pay my bil at the climic? ..." returned NOISE-0016, NOISE-0134, NOISE-0152, NOISE-0131, NOISE-0162
- noisy/with_noise N12: "Can I get my money asdf bakc if I paid in hmm?? advance?" returned NOISE-0174, NOISE-0169, NOISE-0118, NOISE-0167, NOISE-0145
- noisy/with_noise N14: "Whhat should I do if xD hmm?? there is a medical emergency?" returned NOISE-0199, NOISE-0167, NOISE-0166, NOISE-0151, NOISE-0149
- noisy/with_noise N15: "How do I pepare for a caardiology xD viit? 1234" returned NOISE-0162, NOISE-0150, NOISE-0186, NOISE-0152, NOISE-0019
- noisy/with_noise N16: "zzkx I kep geetting heartburn affter eatibg and acid comes plz up my throta" returned NOISE-0114, NOISE-0105, NOISE-0184, NOISE-0165, NOISE-0103
- noisy/with_noise N19: "I am vey zzkx thirsty all the time and urinate a ~~ lot" returned NOISE-0105, NOISE-0114, NOISE-0165, NOISE-0184, NOISE-0126
- noisy/with_noise N20: "One-sided throbibng hedaache with hmm?? senistivity to 1234 light" returned NOISE-0131, NOISE-0106, NOISE-0151, NOISE-0109, NOISE-0158
- noisy/with_noise N21: "Painful periods with qwe!! bad cramps lol every month" returned NOISE-0106, NOISE-0109, NOISE-0126, NOISE-0149, NOISE-0148
- noisy/with_noise N23: "xD Soore thrroat that hrts hmm?? when I swallow, wiht feber" returned NOISE-0199, NOISE-0140, NOISE-0135, NOISE-0166, NOISE-0153
- noisy/with_noise N24: "I ca'nt fal asleeep at nighht and wake asdf zzkx up exhaustd" returned NOISE-0174, NOISE-0165, NOISE-0130, NOISE-0102, NOISE-0126
- noisy/with_noise N29: "Medixine for allergic ~~ rhinits qwe!! and sneezing" returned NOISE-0079, NOISE-0030, NOISE-0148, NOISE-0120, NOISE-0196

Noisy queries (generated from the matching set, seed 20261001):

- N01 (from M01): qwe!! How can ### I sign up for a new CareBridge account?
- N02 (from M02): Is it poossible to ... log in using my Google plz accoun?t
- N03 (from M03): Wht are the steps to bok hmm?? a doctor ~~ apopintment?
- N04 (from M04): What dors it mean when my ### appointment qwe!! sasy requeste?
- N05 (from M05): How do I cancel ... my xD booking?
- N06 (from M06): qwe!! Can I moev my appointment plz to anothher dayy?
- N07 (from M07): lol What happesn if I miss my lol appointmrnt?
- N08 (from M08): How qwe!! @@ des the clinic waitlist wrok?
- N09 (from M09): hmm?? How much time asdf do I get to accept a waitlist skot offre?
- N10 (from M10): Do ### I get a reminder before my ### visit?
- N11 (from M11): How can 1234 I pay my bil at the climic? ...
- N12 (from M12): Can I get my money asdf bakc if I paid in hmm?? advance?
- N13 (from M13): Is the AI asssistant a replacement hmm?? for medical advice from xD a docto?r
- N14 (from M14): Whhat should I do if xD hmm?? there is a medical emergency?
- N15 (from M15): How do I pepare for a caardiology xD viit? 1234
- N16 (from M16): zzkx I kep geetting heartburn affter eatibg and acid comes plz up my throta
- N17 (from M17): qwe!! Itchy red ring-shaped rash ... spreading on my arm
- N18 (from M18): Wheezing qwe!! and coughing at night, @@ which specialist shoud I see?
- N19 (from M19): I am vey zzkx thirsty all the time and urinate a ~~ lot
- N20 (from M20): One-sided throbibng hedaache with hmm?? senistivity to 1234 light
- N21 (from M21): Painful periods with qwe!! bad cramps lol every month
- N22 (from M22): Swollen anke adter twisting it ... xD while playing football
- N23 (from M23): xD Soore thrroat that hrts hmm?? when I swallow, wiht feber
- N24 (from M24): I ca'nt fal asleeep at nighht and wake asdf zzkx up exhaustd
- N25 (from M25): Burning when I pee and I ned ... to qwe!! go often
- N26 (from M26): xD What mediciines are usually prrescribed @@ for typhoid fever?
- N27 (from M27): hmm?? Commmon treatment for dengue fecer zzkx
- N28 (from M28): Wat is prescribed plz for @@ hypothyroidism?
- N29 (from M29): Medixine for allergic ~~ rhinits qwe!! and sneezing
- N30 (from M30): qwe!! What do doctors give for ... ion deficiency anaemia?
