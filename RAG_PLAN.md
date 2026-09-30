# CareBridge RAG — Implementation Plan

Status: agreed design, implementation in progress. Evaluation happens after integration works.

## 1. Embeddings

- Model: Gemini `gemini-embedding-001`, 768 dimensions.
- Called through a new LiteLLM alias `carebridge-embed` (in `carebridge-liteLLM`), so the provider
  can be changed in one config file.
- Documents and user questions must always be embedded with the same model. The chat model that
  writes the final answer is independent and can be any provider.
- Changing the embedding model means re-embedding the whole corpus (minutes, low cost).

## 2. Storage

- Supabase project database with the `pgvector` extension (installed, not yet enabled).
- Migration lives in `carebridge-clinic-flow/supabase/migrations/`.
- One table, `rag_documents`, one row per record (records are short, no chunking):

| Column | Purpose |
|---|---|
| `doc_id` (PK) | `VN-…`, `RX-…`, `FAQ-…` |
| `record_type` | `visit_note`, `prescription`, `faq` |
| `content` | record text (what is searched and returned) |
| `specialization`, `diagnosis`, `faq_topic` | filters |
| `embedding` | `vector(768)`, HNSW index (cosine) |
| `search_text` | generated `tsvector` for keyword search; trigram index for typo tolerance |
| `rag_visible` | false for doctor-specific FAQ (see Section 4) |
| `is_noise`, `noise_type`, `source_doc_id` | noise rows for evaluation (added later) |

- Evaluation ground truth (`answer_facts`, anchors, difficulty) stays in this repository, not in the
  database.
- Security: RLS enabled; authenticated users may `select` only; no insert/update/delete policies.
  Loading uses the service role key from a local `.env` that is never committed.
- The table has no foreign keys to `profiles`, `appointments`, or any real user data. All records are
  synthetic.

## 3. Search

- Hybrid search in one SQL function (RPC), e.g.
  `match_rag_documents(query_text, query_embedding, match_count, record_type, specialization)`:
  - vector similarity (cosine) on `embedding`;
  - keyword search on `search_text` plus trigram similarity for typos;
  - merged with reciprocal rank fusion.
- Default top 5 results. A minimum-similarity cutoff returns nothing for unrelated questions.
- Only rows with `rag_visible = true` and `is_noise = false` are returned to the AI in production;
  evaluation can include noise rows.

## 4. AI tool

- New tool `search_knowledge` in the `carebridge-ai-v2` Edge Function.
  - Input: `query`, optional `record_type`, optional `specialization`.
  - Steps: embed the query via LiteLLM `carebridge-embed`, call the search RPC with the user's JWT
    (RLS applies), return the top records (`doc_id`, type, content).
- Prompt rules:
  - Use for general questions about symptoms, conditions, medicines, and clinic policy.
  - The user's own appointments, prescriptions, and bills still use the existing tools.
  - Never name patients or doctors from retrieved records. Describe them as similar cases.
  - For "which doctor" questions, name only the specialization from the RAG, then use the existing
    real-doctor tool to list actual doctors.
  - Always state that this is general information, not medical advice; point to 999 for emergencies.
  - If nothing relevant is found, say so instead of guessing.
- Doctor-specific FAQ (topics Doctor schedule, Doctor fees, Doctor profile, Specialization doctors;
  120 rows) describe fictional doctors, so they are stored with `rag_visible = false` and are used
  only for evaluation.

## 5. Evaluation (after integration)

- Noise documents (typos, junk, off-topic rows) flagged with `is_noise`.
- Three query sets: matching, extreme/edge, noisy (typos and junk).
- Report retrieval quality (hit rate / recall@k, MRR) on clean vs clean-plus-noise index, with clean
  vs noisy queries.

## Build order

| Step | Where | Changes production |
|---|---|---|
| 1. Merge CSVs and manifest into `corpus/corpus_clean.jsonl` | carebridge-rag | No |
| 2. Add `carebridge-embed` alias | carebridge-liteLLM | Yes (gateway redeploy) |
| 3. Migration: pgvector, table, indexes, RLS, search RPC | carebridge-clinic-flow | Yes (database) |
| 4. Embed and upload script | carebridge-rag | Yes (writes data) |
| 5. `search_knowledge` tool and prompt rules | carebridge-clinic-flow Edge Function | Yes (deploy) |
| 6. Manual testing in the app | app | No |
| 7. Evaluation scripts and report | carebridge-rag | No |

Every step that changes production is approved before it runs.

Progress:

- Steps 1 and 2 are done. The live gateway returns 768-dimension vectors for `carebridge-embed`.
- Step 3 is done. Migrations `20260930000000_rag_documents.sql` and
  `20260930000100_rag_documents_source_idx.sql` are applied. Tests with temporary rows confirmed
  that signed-in users see only visible clean rows (even with the include flags set), `anon` has no
  access, and the service role can include noise and hidden rows. A typo query without an
  embedding only matches when trigram similarity is at least 0.6, so real queries rely on the
  embedding for typo tolerance; step 7 measures this.
