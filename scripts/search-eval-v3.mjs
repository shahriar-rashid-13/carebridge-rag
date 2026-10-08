// Search evaluation for CareBridge AI v3 (Assessment 3).
//
// Parts:
// 1. Dense only, same 1,960 rows (FAQ and prescriptions): gemini-embedding-001 vs gte-small,
//    cosine top 5 with no keyword search. Separates the embedding model from corpus size.
// 2. A3a vs A3b on the full gte-small index (clean): match_rag_documents returns 20 candidates
//    (as in v3); A3a keeps the fused order, A3b re-ranks them with the app model (same prompt
//    as v3, one try, 20 s timeout). A2 and A3a at k = 5 come from the earlier reports.
// 3. Judged answers for the 30 matching queries: an answer is written from the A2 top 5 and from
//    the A3b top 5, and the judge model scores faithfulness and relevance (1 to 5).
// 4. A3c: 15 policy questions, answered from the A3b search results (RAG only) and from the
//    OKF policy file; the judge scores correctness against the policy file.
//
// Model calls go through the LiteLLM gateway: carebridge-agent answers and re-ranks,
// carebridge-judge (a different Gemini model) judges. Every model reply is cached in
// eval/.cache/search-eval-v3.json, so a stopped run resumes without repeating calls.
//
// Usage: node scripts/search-eval-v3.mjs [--pace 3000]
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LITELLM_BASE_URL, LITELLM_MASTER_KEY from .env.
// Writes eval/search-eval-v3-results.json and eval/SEARCH_EVAL_V3_REPORT.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "eval");
const CACHE_FILE = path.join(EVAL_DIR, ".cache", "search-eval-v3.json");
const OKF_MODULE = path.join(ROOT, "..", "carebridge-clinic-flow", "supabase", "functions", "carebridge-ai-v3", "okf.ts");
const K = 5;
const CANDIDATES = 20;
const MIN_SIMILARITY_GTE = 0.82;
// v3 gives the re-rank 6 s in production. The eval allows 20 s so the gateway's retry on the
// second Gemini key can answer; the production fallback share is visible on /metrics.
const RERANK_TIMEOUT_MS = 20000;
const RERANK_SNIPPET_CHARS = 500;
const MODEL_TIMEOUT_MS = 60000;

process.loadEnvFile(path.join(ROOT, ".env"));
const env = process.env;
for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LITELLM_BASE_URL", "LITELLM_MASTER_KEY"]) {
  if (!env[key]) throw new Error(`${key} missing in .env`);
}
const paceIndex = process.argv.indexOf("--pace");
const PACE_MS = paceIndex > 0 ? Number(process.argv[paceIndex + 1]) : 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x) => x.toFixed(2);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const cache = fs.existsSync(CACHE_FILE) ? readJson(CACHE_FILE) : {};
const saveCache = () => {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
};

function supabaseHeaders() {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function request(label, url, init, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      const wait = Math.min(5000 * 2 ** (attempt - 1), 90000);
      console.log(`  ${label}: HTTP ${res.status}, retry in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${label} failed with HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** One chat call through the gateway; the reply is cached under `key`. */
async function chat(key, model, prompt, timeoutMs = MODEL_TIMEOUT_MS) {
  if (cache[key]) return cache[key];
  await sleep(PACE_MS);
  let entry;
  try {
    const res = await request(
      key,
      `${env.LITELLM_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      },
      // The re-rank keeps v3's behaviour: one try, then the fused order.
      model === "carebridge-agent" && timeoutMs === RERANK_TIMEOUT_MS ? 1 : 6,
    );
    const json = await res.json();
    entry = {
      ok: true,
      content: json.choices?.[0]?.message?.content ?? "",
      group: res.headers.get("x-litellm-model-group"),
      tokens: json.usage?.total_tokens ?? null,
    };
  } catch (err) {
    entry = { ok: false, error: err.message.slice(0, 300) };
  }
  cache[key] = entry;
  saveCache();
  return entry;
}

function parseJsonObject(text) {
  const match = text?.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ---- Relevance, as in scripts/rag-eval.mjs ----

const isRelevant = (q, row) =>
  !row.doc_id.startsWith("NOISE-") &&
  ((q.relevant?.faq ?? []).includes(row.doc_id) || (q.relevant?.diagnosis ?? []).includes(row.diagnosis));

function score(q, rows) {
  const flags = rows.slice(0, K).map((row) => isRelevant(q, row));
  const first = flags.indexOf(true);
  return {
    returned: rows.length,
    hit: first >= 0 ? 1 : 0,
    rr: first >= 0 ? 1 / (first + 1) : 0,
    p_at_k: flags.filter(Boolean).length / K,
    top: rows.slice(0, K).map((row, i) => `${row.doc_id}${flags[i] ? "*" : ""}`),
  };
}

function summarise(rows) {
  const answerable = rows.filter((r) => !r.q.expect_empty);
  const outOfScope = rows.filter((r) => r.q.expect_empty);
  return {
    queries: answerable.length,
    hit_rate: mean(answerable.map((r) => r.s.hit)),
    mrr: mean(answerable.map((r) => r.s.rr)),
    p_at_k: mean(answerable.map((r) => r.s.p_at_k)),
    out_of_scope: outOfScope.length,
    correct_empty: outOfScope.filter((r) => r.s.returned === 0).length,
  };
}

// ---- Data ----

const queries = readJson(path.join(EVAL_DIR, "rag-queries.json"));
const gteReport = readJson(path.join(EVAL_DIR, "rag-eval-results-gte.json"));
const a2Report = readJson(path.join(EVAL_DIR, "rag-eval-results.json"));
const matchingById = new Map(queries.matching.map((q) => [q.id, q]));
const SETS = {
  matching: queries.matching,
  edge: queries.edge,
  noisy: gteReport.noisy_queries.map((q) => ({ ...q, relevant: matchingById.get(q.from).relevant })),
};
const policyQueries = readJson(path.join(EVAL_DIR, "policy-queries.json")).queries;

const parseVector = (value) => (typeof value === "string" ? JSON.parse(value) : value);

async function fetchRows(select, filter) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await request(
      "rows",
      `${env.SUPABASE_URL}/rest/v1/rag_documents?select=${select}&${filter}&order=doc_id&offset=${offset}&limit=1000`,
      { headers: supabaseHeaders() },
    );
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

let gteExtractor = null;
async function gteVectors(texts) {
  const file = path.join(EVAL_DIR, ".cache", "query-embeddings-gte.json");
  const vectors = fs.existsSync(file) ? readJson(file) : {};
  const missing = [...new Set(texts.filter((t) => !vectors[t]))];
  if (missing.length) {
    if (!gteExtractor) {
      const { pipeline } = await import("@huggingface/transformers");
      gteExtractor = await pipeline("feature-extraction", "Supabase/gte-small", { dtype: "fp32" });
    }
    const out = (await gteExtractor(missing, { pooling: "mean", normalize: true })).tolist();
    missing.forEach((t, i) => (vectors[t] = out[i]));
    fs.writeFileSync(file, JSON.stringify(vectors));
  }
  return vectors;
}

// ---- Part 1: dense only on the same 1,960 rows ----

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

async function denseSameRows() {
  console.log("Part 1: dense only, same rows");
  const rows = (
    await fetchRows("doc_id,record_type,diagnosis,embedding,embedding_gte", "embedding=not.is.null&is_noise=is.false")
  ).map((row) => ({ ...row, embedding: parseVector(row.embedding), embedding_gte: parseVector(row.embedding_gte) }));
  const texts = Object.values(SETS).flat().map((q) => q.query);
  const gemini = readJson(path.join(EVAL_DIR, ".cache", "query-embeddings.json"));
  const gte = await gteVectors(texts);
  const missing = texts.filter((t) => !gemini[t]);
  if (missing.length) throw new Error(`${missing.length} queries have no cached Gemini embedding`);

  const out = { rows: rows.length, summary: [] };
  for (const [model, column, vectors] of [
    ["gemini-embedding-001", "embedding", gemini],
    ["gte-small", "embedding_gte", gte],
  ]) {
    for (const [set, list] of Object.entries(SETS)) {
      const scored = list.map((q) => {
        const ranked = rows
          .map((row) => ({ row, sim: cosine(vectors[q.query], row[column]) }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, K)
          .map((x) => x.row);
        return { q, s: score(q, ranked) };
      });
      const { out_of_scope, correct_empty, ...summary } = summarise(scored);
      out.summary.push({ model, set, ...summary });
      console.log(`  ${model.padEnd(22)} ${set.padEnd(8)} hit ${fmt(summary.hit_rate)} mrr ${fmt(summary.mrr)}`);
    }
  }
  return out;
}

// ---- Part 2: A3a vs A3b ----

function rerankPrompt(query, candidates) {
  const list = candidates
    .map((c, i) => `[${i + 1}] ${c.content.slice(0, RERANK_SNIPPET_CHARS).replace(/\s+/g, " ")}`)
    .join("\n");
  return [
    "Rank the passages by how well they answer the question. Ignore passages that do not help.",
    `Question: ${query}`,
    "Passages:",
    list,
    `Reply with only JSON like {"ranking": [3, 1, 7]}: the numbers of the ${K} most useful passages, best first.`,
  ].join("\n");
}

function parseRanking(raw, count) {
  const ranking = parseJsonObject(raw)?.ranking;
  if (!Array.isArray(ranking)) return null;
  const indexes = [];
  for (const value of ranking) {
    const n = typeof value === "string" ? Number(value) : value;
    if (Number.isInteger(n) && n >= 1 && n <= count && !indexes.includes(n - 1)) indexes.push(n - 1);
  }
  return indexes.length ? indexes : null;
}

async function candidatesFor(query, vectors) {
  const res = await request("search", `${env.SUPABASE_URL}/rest/v1/rpc/match_rag_documents`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      query_text: query,
      query_embedding_gte: `[${vectors[query].join(",")}]`,
      min_similarity_gte: MIN_SIMILARITY_GTE,
      match_count: CANDIDATES,
      include_noise: false,
    }),
  });
  return res.json();
}

/** v3 search: 20 fused candidates, then the model re-rank, falling back to the fused order. */
async function searchV3(id, query, vectors) {
  const candidates = await candidatesFor(query, vectors);
  if (candidates.length <= 1) return { candidates, reranked: candidates.slice(0, K), mode: "fused" };
  const reply = await chat(`rerank:${id}`, "carebridge-agent", rerankPrompt(query, candidates), RERANK_TIMEOUT_MS);
  const ranking = reply.ok ? parseRanking(reply.content, candidates.length) : null;
  if (!ranking) return { candidates, reranked: candidates.slice(0, K), mode: "fused", error: reply.error ?? "invalid ranking" };
  return { candidates, reranked: ranking.slice(0, K).map((i) => candidates[i]), mode: "reranked" };
}

async function rerankEval(vectors) {
  console.log("Part 2: A3a (fused) vs A3b (re-ranked), 20 candidates");
  const out = { summary: [], details: [], searches: {} };
  for (const [set, list] of Object.entries(SETS)) {
    const fused = [];
    const reranked = [];
    let fallbacks = 0;
    for (const q of list) {
      const id = `${set}:${q.id}`;
      const result = await searchV3(id, q.query, vectors);
      out.searches[id] = result;
      if (result.mode === "fused" && result.candidates.length > 1) fallbacks++;
      const sf = score(q, result.candidates);
      const sr = score(q, result.reranked);
      fused.push({ q, s: sf });
      reranked.push({ q, s: sr });
      out.details.push({ set, id: q.id, query: q.query, mode: result.mode, fused: sf.top, reranked: sr.top });
    }
    out.summary.push({ set, variant: "A3a fused (20 to 5)", ...summarise(fused) });
    out.summary.push({ set, variant: "A3b re-ranked (20 to 5)", ...summarise(reranked), rerank_fallbacks: fallbacks });
    const [a, b] = out.summary.slice(-2);
    console.log(`  ${set.padEnd(8)} fused hit ${fmt(a.hit_rate)} mrr ${fmt(a.mrr)} | re-ranked hit ${fmt(b.hit_rate)} mrr ${fmt(b.mrr)} (fallbacks ${fallbacks})`);
  }
  return out;
}

// ---- Parts 3 and 4: answers and judge ----

function answerPrompt(question, passages) {
  const list = passages.length
    ? passages.map((p) => `[${p.doc_id}] ${p.content.replace(/\s+/g, " ").slice(0, 800)}`).join("\n")
    : "(no passages)";
  return [
    "You are a clinic assistant. Answer the question using only the passages below.",
    "Cite the passage id in brackets after each fact. If the passages do not answer the question, say you do not know.",
    "Never give medicine doses. Keep the answer under 120 words.",
    `Question: ${question}`,
    "Passages:",
    list,
  ].join("\n");
}

function judgePrompt(question, passages, answer) {
  const list = passages.map((p) => `[${p.doc_id}] ${p.content.replace(/\s+/g, " ").slice(0, 800)}`).join("\n");
  return [
    "You grade an answer from a clinic assistant.",
    "faithfulness: 5 = every claim is supported by the passages, 1 = mostly unsupported or invented.",
    "relevance: 5 = fully answers the question, 1 = does not answer it. Saying 'I do not know' when the passages do not help is faithful but scores low on relevance.",
    `Question: ${question}`,
    "Passages:",
    list || "(no passages)",
    `Answer: ${answer}`,
    'Reply with only JSON: {"faithfulness": 1-5, "relevance": 1-5, "reason": "one sentence"}',
  ].join("\n");
}

function correctnessPrompt(question, reference, answer) {
  return [
    "You check a clinic assistant's answer against the clinic's approved policy text.",
    "correctness: 5 = matches the policy and answers the question, 3 = partly right or vague, 1 = wrong or contradicts the policy.",
    "contradicts: true if any statement in the answer conflicts with the policy.",
    `Question: ${question}`,
    `Policy text:\n${reference}`,
    `Answer: ${answer}`,
    'Reply with only JSON: {"correctness": 1-5, "contradicts": true or false, "reason": "one sentence"}',
  ].join("\n");
}

async function contentByIds(ids) {
  if (!ids.length) return [];
  const rows = await fetchRows("doc_id,content", `doc_id=in.(${ids.join(",")})`);
  const byId = new Map(rows.map((r) => [r.doc_id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function judgedAnswers(searches) {
  console.log("Part 3: judged answers, A2 vs A3b, 30 matching queries");
  const a2Top = new Map(
    a2Report.details
      .filter((d) => d.set === "matching" && d.mode === "hybrid" && d.index === "clean")
      .map((d) => [d.id, d.top.map((t) => t.replace("*", ""))]),
  );
  const rows = [];
  for (const q of queries.matching) {
    for (const [variant, passages] of [
      ["A2", await contentByIds(a2Top.get(q.id) ?? [])],
      ["A3b", searches[`matching:${q.id}`].reranked],
    ]) {
      const answer = await chat(`answer:${variant}:${q.id}`, "carebridge-agent", answerPrompt(q.query, passages));
      if (!answer.ok) {
        rows.push({ id: q.id, variant, error: answer.error });
        continue;
      }
      const verdict = await chat(`judge:${variant}:${q.id}`, "carebridge-judge", judgePrompt(q.query, passages, answer.content));
      const parsed = verdict.ok ? parseJsonObject(verdict.content) : null;
      rows.push({
        id: q.id,
        variant,
        query: q.query,
        answer: answer.content,
        faithfulness: Number(parsed?.faithfulness) || null,
        relevance: Number(parsed?.relevance) || null,
        reason: parsed?.reason ?? verdict.error ?? "unparsed",
      });
    }
    console.log(`  ${q.id} done`);
  }
  const summary = ["A2", "A3b"].map((variant) => {
    const list = rows.filter((r) => r.variant === variant && r.faithfulness && r.relevance);
    return {
      variant,
      judged: list.length,
      faithfulness: mean(list.map((r) => r.faithfulness)),
      relevance: mean(list.map((r) => r.relevance)),
    };
  });
  return { summary, rows };
}

async function policyEval(vectors) {
  console.log("Part 4: A3c, RAG only vs OKF, 15 policy questions");
  const { loadOkf, findOkf } = await import(pathToFileURL(OKF_MODULE).href);
  const docs = loadOkf();
  const rows = [];
  for (const q of policyQueries) {
    const doc = docs.find((d) => d.id === q.okf_id);
    if (!doc) throw new Error(`${q.id}: unknown okf_id ${q.okf_id}`);
    const reference = doc.body;
    const keywordMatch = findOkf(docs, q.query)?.id ?? null;
    const rag = await searchV3(`policy:${q.id}`, q.query, vectors);
    const variants = [
      ["RAG only", rag.reranked],
      ["OKF", [{ doc_id: `OKF:${doc.id}`, content: reference }]],
    ];
    for (const [variant, passages] of variants) {
      const answer = await chat(`policy-answer:${variant}:${q.id}`, "carebridge-agent", answerPrompt(q.query, passages));
      if (!answer.ok) {
        rows.push({ id: q.id, variant, error: answer.error });
        continue;
      }
      const verdict = await chat(
        `policy-judge:${variant}:${q.id}`,
        "carebridge-judge",
        correctnessPrompt(q.query, reference, answer.content),
      );
      const parsed = verdict.ok ? parseJsonObject(verdict.content) : null;
      rows.push({
        id: q.id,
        variant,
        query: q.query,
        okf_id: q.okf_id,
        keyword_match: keywordMatch,
        sources: passages.map((p) => p.doc_id),
        answer: answer.content,
        correctness: Number(parsed?.correctness) || null,
        contradicts: parsed?.contradicts === true,
        reason: parsed?.reason ?? verdict.error ?? "unparsed",
      });
    }
    console.log(`  ${q.id} done`);
  }
  const summary = ["RAG only", "OKF"].map((variant) => {
    const list = rows.filter((r) => r.variant === variant && r.correctness);
    return {
      variant,
      judged: list.length,
      correctness: mean(list.map((r) => r.correctness)),
      fully_correct: list.filter((r) => r.correctness >= 4 && !r.contradicts).length,
      contradictions: list.filter((r) => r.contradicts).length,
    };
  });
  const keywordHits = policyQueries.filter((q) => rows.find((r) => r.id === q.id)?.keyword_match === q.okf_id).length;
  return { summary, keyword_router_hits: keywordHits, rows };
}

// ---- Report ----

function a2a3aRows() {
  const pick = (report, label) =>
    report.summary
      .filter((s) => s.mode === "hybrid" && s.index === "clean")
      .map((s) => ({ variant: label, set: s.set, ...s }));
  return [
    ...pick(a2Report, "A2 Gemini, 1,960 rows (k = 5)"),
    ...pick(gteReport, "A3a gte-small, 20,758 rows (k = 5)"),
  ];
}

function report(result) {
  const table = (rows, label) =>
    rows
      .map((s) => `| ${s[label]} | ${s.set} | ${s.queries} | ${fmt(s.hit_rate)} | ${fmt(s.mrr)} | ${fmt(s.p_at_k)} |`)
      .join("\n");
  const r2 = result.rerank.summary;
  const j = result.judged.summary;
  const p = result.policy.summary;
  const oos = r2.filter((s) => s.out_of_scope > 0);
  return `# CareBridge search evaluation for AI v3

Run: ${result.run_at} · k = ${K} · clean index (no noise rows), the setting the app uses.

Variants:

- **A2**: Assessment 2 search, gemini-embedding-001 on 1,960 rows (FAQ and prescriptions), hybrid search. From \`RAG_EVAL_REPORT.md\`.
- **A3a**: gte-small on all 20,758 rows, hybrid search. From \`RAG_EVAL_REPORT_GTE.md\` (k = 5) and re-run here with 20 candidates as v3 does.
- **A3b**: A3a with 20 candidates re-ranked to 5 by the app model (\`carebridge-agent\`, Gemini 3.1 Flash Lite), same prompt as v3. The eval allows 20 s per re-rank (production: 6 s, then the fused order), so the gateway can retry on the second Gemini key.
- **Dense only**: both embedding models on the same ${result.dense.rows} rows with cosine search only, to separate the model from corpus size.
- **A3c**: policy questions answered from search results only vs from the approved OKF policy file.

Judge: \`carebridge-judge\` (Gemini 3.5 Flash), a different model from the answer model.

## 1. Retrieval: A2 vs A3a vs A3b

| Variant | Set | Queries | Hit@5 | MRR | P@5 |
|---|---|---|---|---|---|
${table(a2a3aRows(), "variant")}
${table(r2, "variant")}

Re-rank fallbacks to the fused order (timeout or invalid reply): ${r2
    .filter((s) => s.rerank_fallbacks !== undefined)
    .map((s) => `${s.set} ${s.rerank_fallbacks}`)
    .join(", ")}.

Out-of-scope queries returning nothing (20 candidates): ${oos.map((s) => `${s.variant} ${s.correct_empty} of ${s.out_of_scope}`).join("; ") || "none"}.

## 2. Dense only on the same ${result.dense.rows} rows

| Model | Set | Queries | Hit@5 | MRR | P@5 |
|---|---|---|---|---|---|
${table(result.dense.summary, "model")}

## 3. Judged answers (30 matching queries)

| Variant | Judged | Faithfulness (1-5) | Relevance (1-5) |
|---|---|---|---|
${j.map((s) => `| ${s.variant} | ${s.judged} | ${fmt(s.faithfulness)} | ${fmt(s.relevance)} |`).join("\n")}

## 4. A3c: policy questions, RAG only vs OKF

| Variant | Judged | Correctness (1-5) | Fully correct | Contradicts policy |
|---|---|---|---|---|
${p.map((s) => `| ${s.variant} | ${s.judged} | ${fmt(s.correctness)} | ${s.fully_correct} | ${s.contradictions} |`).join("\n")}

The keyword router (\`findOkf\`, used when the supervisor model fails) picked the right policy file for ${result.policy.keyword_router_hits} of ${policyQueries.length} paraphrased questions. With the supervisor model, policy routing is measured in the agent evaluation.

Answers that contradict the policy:

${
  result.policy.rows
    .filter((r) => r.contradicts)
    .map((r) => `- ${r.id} ${r.variant}: "${r.query}" (${r.reason})`)
    .join("\n") || "- none"
}

## Re-rank changes (matching set)

${
  result.rerank.details
    .filter((d) => d.set === "matching" && d.fused.join() !== d.reranked.join())
    .map((d) => `- ${d.id} ${d.mode}: fused ${d.fused.join(", ")} / re-ranked ${d.reranked.join(", ")}`)
    .join("\n") || "- none"
}
`;
}

async function main() {
  const allTexts = [...Object.values(SETS).flat().map((q) => q.query), ...policyQueries.map((q) => q.query)];
  const vectors = await gteVectors(allTexts);
  const dense = await denseSameRows();
  const rerank = await rerankEval(vectors);
  const judged = await judgedAnswers(rerank.searches);
  const policy = await policyEval(vectors);
  const { searches, ...rerankOut } = rerank;
  const result = { run_at: new Date().toISOString(), dense, rerank: rerankOut, judged, policy };
  fs.writeFileSync(path.join(EVAL_DIR, "search-eval-v3-results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(EVAL_DIR, "SEARCH_EVAL_V3_REPORT.md"), report(result));
  console.log("Wrote eval/search-eval-v3-results.json and eval/SEARCH_EVAL_V3_REPORT.md");
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  process.exit(1);
});
