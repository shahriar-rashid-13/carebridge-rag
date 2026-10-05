# CareBridge RAG evaluation

Run: 2026-10-05T10:11:52.406Z · k = 5 · Supabase/gte-small (384 dims), local transformers.js for documents and queries

Search: match_rag_documents: cosine >= 0.82 or trigram >= 0.6, fused with full text by reciprocal rank fusion.

Index: 20758 clean embedded rows plus 300 noise rows
(100 typo duplicates of real records, 100 junk rows, 100 off-topic rows).
"clean" excludes noise rows (`include_noise = false`, what the app uses); "with_noise" includes them.

Metrics (answerable queries only):

- hit_rate: share of queries with at least one relevant result in the top 5.
- mrr: mean reciprocal rank of the first relevant result.
- p@5: relevant results in the top 5 divided by 5. Single-answer FAQ queries can score at most 0.2 to 0.4.
- noise: share of top-5 slots taken by noise rows.

| Set | Mode | Index | Queries | Hit rate | MRR | P@5 | Noise in top 5 |
|---|---|---|---|---|---|---|---|
| matching | hybrid | clean | 30 | 1.00 | 0.97 | 0.56 | 0.00 |
| matching | hybrid | with_noise | 30 | 0.97 | 0.91 | 0.55 | 0.12 |
| matching | keyword_only | clean | 30 | 0.80 | 0.71 | 0.41 | 0.00 |
| matching | keyword_only | with_noise | 30 | 0.77 | 0.68 | 0.41 | 0.14 |
| edge | hybrid | clean | 25 | 0.88 | 0.88 | 0.62 | 0.00 |
| edge | hybrid | with_noise | 25 | 0.84 | 0.84 | 0.60 | 0.12 |
| edge | keyword_only | clean | 25 | 0.84 | 0.82 | 0.57 | 0.00 |
| edge | keyword_only | with_noise | 25 | 0.84 | 0.75 | 0.54 | 0.14 |
| noisy | hybrid | clean | 30 | 0.87 | 0.79 | 0.49 | 0.00 |
| noisy | hybrid | with_noise | 30 | 0.60 | 0.51 | 0.37 | 0.44 |
| noisy | keyword_only | clean | 30 | 0.73 | 0.68 | 0.44 | 0.00 |
| noisy | keyword_only | with_noise | 30 | 0.43 | 0.29 | 0.24 | 0.65 |

Out-of-scope queries (correct answer is no result):

| Mode | Index | Returned nothing |
|---|---|---|
| hybrid | clean | 5 of 5 |
| hybrid | with_noise | 5 of 5 |
| keyword_only | clean | 1 of 5 |
| keyword_only | with_noise | 1 of 5 |

Hybrid-mode misses (no relevant result in the top 5):

- matching/with_noise M11: "How can I pay my bill at the clinic?" returned NOISE-0112, NOISE-0141, NOISE-0132, NOISE-0162, NOISE-0200
- edge/clean E05: "BPPV" returned nothing
- edge/clean E09: "chest pain" returned VN-004247, VN-006297, VN-006834, VN-007185, VN-011095
- edge/clean E25: "Do you take patients without an appointment?" returned FAQ-000017, FAQ-000010, FAQ-000028, FAQ-000009, FAQ-000005
- edge/with_noise E01: "refund" returned NOISE-0183, NOISE-0182, NOISE-0161, NOISE-0118, NOISE-0151
- edge/with_noise E05: "BPPV" returned nothing
- edge/with_noise E09: "chest pain" returned VN-006297, VN-009119, VN-004247, VN-006834, NOISE-0181
- edge/with_noise E25: "Do you take patients without an appointment?" returned FAQ-000017, FAQ-000010, FAQ-000028, FAQ-000009, FAQ-000005
- noisy/clean N03: "Wht are the steps to bok hmm?? a doctor ~~ apopintment?" returned RX-001538, RX-002973, FAQ-000116, RX-005243, RX-009126
- noisy/clean N06: "qwe!! Can I moev my appointment plz to anothher dayy?" returned FAQ-000009, FAQ-000021, FAQ-000026, FAQ-000022, FAQ-000014
- noisy/clean N15: "How do I pepare for a caardiology xD viit? 1234" returned RX-006465, RX-006862, RX-006666, RX-008674, RX-009683
- noisy/clean N20: "One-sided throbibng hedaache with hmm?? senistivity to 1234 light" returned nothing
- noisy/with_noise N03: "Wht are the steps to bok hmm?? a doctor ~~ apopintment?" returned RX-001538, RX-002973, RX-005243, RX-009126, RX-003838
- noisy/with_noise N06: "qwe!! Can I moev my appointment plz to anothher dayy?" returned NOISE-0135, NOISE-0196, NOISE-0200, NOISE-0152, NOISE-0141
- noisy/with_noise N07: "lol What happesn if I miss my lol appointmrnt?" returned NOISE-0170, NOISE-0162, NOISE-0135, NOISE-0136, NOISE-0149
- noisy/with_noise N08: "How qwe!! @@ des the clinic waitlist wrok?" returned NOISE-0155, NOISE-0144, NOISE-0143, NOISE-0157, NOISE-0165
- noisy/with_noise N11: "How can 1234 I pay my bil at the climic? ..." returned RX-008380, NOISE-0158, RX-007614, NOISE-0152, NOISE-0131
- noisy/with_noise N12: "Can I get my money asdf bakc if I paid in hmm?? advance?" returned NOISE-0174, NOISE-0169, NOISE-0118, NOISE-0167, NOISE-0125
- noisy/with_noise N14: "Whhat should I do if xD hmm?? there is a medical emergency?" returned NOISE-0199, NOISE-0167, NOISE-0151, NOISE-0104, NOISE-0152
- noisy/with_noise N15: "How do I pepare for a caardiology xD viit? 1234" returned NOISE-0104, RX-006465, RX-006862, NOISE-0158, RX-006666
- noisy/with_noise N16: "zzkx I kep geetting heartburn affter eatibg and acid comes plz up my throta" returned RX-002276, NOISE-0155, NOISE-0114, RX-004510, NOISE-0187
- noisy/with_noise N20: "One-sided throbibng hedaache with hmm?? senistivity to 1234 light" returned NOISE-0131, NOISE-0167, NOISE-0173, NOISE-0126, NOISE-0164
- noisy/with_noise N23: "xD Soore thrroat that hrts hmm?? when I swallow, wiht feber" returned NOISE-0166, RX-000035, NOISE-0167, RX-000372, NOISE-0199
- noisy/with_noise N24: "I ca'nt fal asleeep at nighht and wake asdf zzkx up exhaustd" returned NOISE-0165, NOISE-0174, NOISE-0200, NOISE-0122, NOISE-0118

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
