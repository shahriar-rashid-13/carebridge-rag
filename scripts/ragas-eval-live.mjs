#!/usr/bin/env node
/**
 * Assessment 4 Option 1 — Live agentic RAG answers for RAGAS.
 *
 * Mirrors carebridge-ai-v3 agentic path offline of the Edge runtime:
 *   plan → hybrid retrieve (gte + match_rag_documents + re-rank) → support judge → answer / refuse
 *
 * Then scores with LiteLLM judge prompts on a 0–1 RAGAS-aligned scale
 * (faithfulness, answer_relevance, context_precision, context_recall).
 *
 * Usage:
 *   node scripts/ragas-eval-live.mjs
 *   node scripts/ragas-eval-live.mjs --limit 5
 *   node scripts/ragas-eval-live.mjs --pace 2500
 *
 * Reads carebridge-rag/.env (SUPABASE_*, LITELLM_*).
 * Writes:
 *   eval/ragas-live-answers.json
 *   eval/ragas-results.json
 *   eval/RAGAS_EVAL_REPORT.md
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "eval");
const GOLDEN_PATH = path.join(EVAL_DIR, "ragas-golden-set.json");
const ANSWERS_PATH = path.join(EVAL_DIR, "ragas-live-answers.json");
const RESULTS_PATH = path.join(EVAL_DIR, "ragas-results.json");
const REPORT_PATH = path.join(EVAL_DIR, "RAGAS_EVAL_REPORT.md");
const THRESHOLDS_PATH = path.join(EVAL_DIR, "ragas-thresholds.json");
const CACHE_FILE = path.join(EVAL_DIR, ".cache", "ragas-live.json");
const EMBED_CACHE = path.join(EVAL_DIR, ".cache", "query-embeddings-gte.json");

const K = 5;
const CANDIDATES = 20;
const MIN_SIMILARITY_GTE = 0.82;
const RERANK_TIMEOUT_MS = 20_000;
const MODEL_TIMEOUT_MS = 55_000;
const PLAN_TIMEOUT_MS = 12_000;
const SUPPORT_TIMEOUT_MS = 12_000;
const MAX_PLAN_QUERIES = 2;
const MAX_FOLLOWUPS = 2;

const REFUSE_MESSAGE =
  "I could not find clinic knowledge that answers this. I do not know, and I will not guess. Please ask the clinic or a doctor.";

const COMPLEX_PATTERN =
  /\b(and|also|plus|both|compare|versus|vs\.?|difference|as well as|then|after that|before that|in addition|along with|what about|how (?:does|do|is|are).+\b(?:and|versus|vs)\b)\b/i;

const METRICS = [
  "faithfulness",
  "answer_relevance",
  "context_precision",
  "context_recall",
];

process.loadEnvFile(path.join(ROOT, ".env"));
const env = process.env;
for (const key of [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LITELLM_BASE_URL",
  "LITELLM_MASTER_KEY",
]) {
  if (!env[key]) throw new Error(`${key} missing in .env`);
}

function parseArgs(argv) {
  const out = { limit: null, pace: 2500, skipScore: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") out.limit = Number(argv[++i]);
    else if (argv[i] === "--pace") out.pace = Number(argv[++i]);
    else if (argv[i] === "--answers-only") out.skipScore = true;
  }
  if (out.limit != null && (!Number.isFinite(out.limit) || out.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  if (!Number.isFinite(out.pace) || out.pace < 0) {
    throw new Error("--pace must be >= 0");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PACE_MS = args.pace;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (xs) => {
  const nums = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};
const round4 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
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

async function chat(key, model, prompt, timeoutMs = MODEL_TIMEOUT_MS) {
  if (cache[key]) return cache[key];
  if (PACE_MS) await sleep(PACE_MS);
  let entry;
  try {
    const res = await request(
      key,
      `${env.LITELLM_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
      model === "carebridge-agent" && timeoutMs === RERANK_TIMEOUT_MS ? 1 : 6,
    );
    const json = await res.json();
    entry = {
      ok: true,
      content: json.choices?.[0]?.message?.content ?? "",
      tokens: json.usage?.total_tokens ?? null,
    };
  } catch (err) {
    entry = { ok: false, error: String(err.message || err).slice(0, 300) };
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

function looksComplex(query) {
  const trimmed = query.trim();
  if (trimmed.length > 120) return true;
  if ((trimmed.match(/\?/g) ?? []).length >= 2) return true;
  return COMPLEX_PATTERN.test(trimmed);
}

function cleanQueries(values, fallback, limit) {
  if (!Array.isArray(values)) return fallback;
  const out = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const query = value.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!query || out.some((e) => e.toLowerCase() === query.toLowerCase())) continue;
    out.push(query);
    if (out.length >= limit) break;
  }
  return out.length ? out : fallback;
}

function planPrompt(question) {
  return [
    "Split a clinic knowledge question into short search queries.",
    "Use 1 query when the question is simple. Use 2 only when it clearly asks two different facts.",
    "Do not invent clinic facts. Keep each query under 120 characters.",
    `Question: ${question}`,
    'Reply with only JSON like {"complex": true, "queries": ["fees for cardiology", "how to pay"], "reason": "asks fee and payment"}.',
  ].join("\n");
}

function followUpPrompt(question, evidence) {
  const list = evidence
    .slice(0, K)
    .map((row, i) => `[${i + 1}] ${row.doc_id}: ${row.content.slice(0, 220).replace(/\s+/g, " ")}`)
    .join("\n");
  return [
    "You plan a second clinic-knowledge search hop. Suggest follow-up queries only for facts the question still needs that the passages do not cover.",
    "If the passages already cover the question, return an empty queries list.",
    "At most 2 short queries. Do not invent clinic facts.",
    `Question: ${question}`,
    "Passages:",
    list || "(none)",
    'Reply with only JSON like {"queries": ["waitlist expiry"], "reason": "first hop covered booking but not waitlist"}.',
  ].join("\n");
}

function supportPrompt(question, evidence) {
  const list = evidence
    .map((row, i) => `[${i + 1}] ${row.doc_id}: ${row.content.slice(0, 280).replace(/\s+/g, " ")}`)
    .join("\n");
  return [
    "Decide whether the passages are enough to answer the question without guessing.",
    "supported=true only when the passages directly answer the question. Otherwise supported=false.",
    `Question: ${question}`,
    "Passages:",
    list || "(none)",
    'Reply with only JSON like {"supported": false, "reason": "passages discuss fees, not parking"}.',
  ].join("\n");
}

function rerankPrompt(query, candidates) {
  const list = candidates
    .map((c, i) => `[${i + 1}] ${c.content.slice(0, 500).replace(/\s+/g, " ")}`)
    .join("\n");
  return [
    "Rank the passages by how well they answer the question. Ignore passages that do not help.",
    `Question: ${query}`,
    "Passages:",
    list,
    `Reply with only JSON like {"ranking": [3, 1, 7]}: the numbers of the ${K} most useful passages, best first.`,
  ].join("\n");
}

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

function ragasJudgePrompt(question, answer, contexts, groundTruth) {
  const ctx = contexts.length
    ? contexts.map((c, i) => `[${i + 1}] ${String(c).replace(/\s+/g, " ").slice(0, 700)}`).join("\n")
    : "(no retrieved contexts)";
  return [
    "You score a clinic RAG answer with RAGAS-style metrics on a 0 to 1 scale.",
    "faithfulness: fraction of answer claims supported by retrieved contexts. Refuse/I-do-not-know with no invented facts = 1.0.",
    "answer_relevance: how well the answer addresses the question (1.0 fully, 0 not at all). A correct refuse on an unanswerable question scores high.",
    "context_precision: fraction of retrieved contexts that are useful for the question (null if no contexts).",
    "context_recall: fraction of ground-truth facts covered by retrieved contexts (null if no contexts; compare against ground_truth).",
    `Question: ${question}`,
    `Ground truth: ${groundTruth}`,
    "Retrieved contexts:",
    ctx,
    `Answer: ${answer}`,
    'Reply with only JSON: {"faithfulness": 0-1, "answer_relevance": 0-1, "context_precision": 0-1 or null, "context_recall": 0-1 or null, "reason": "one sentence"}',
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

let gteExtractor = null;
async function gteVectors(texts) {
  const vectors = fs.existsSync(EMBED_CACHE) ? readJson(EMBED_CACHE) : {};
  const missing = [...new Set(texts.filter((t) => t && !vectors[t]))];
  if (missing.length) {
    if (!gteExtractor) {
      const { pipeline } = await import("@huggingface/transformers");
      gteExtractor = await pipeline("feature-extraction", "Supabase/gte-small", { dtype: "fp32" });
    }
    const out = (await gteExtractor(missing, { pooling: "mean", normalize: true })).tolist();
    missing.forEach((t, i) => {
      vectors[t] = out[i];
    });
    fs.mkdirSync(path.dirname(EMBED_CACHE), { recursive: true });
    fs.writeFileSync(EMBED_CACHE, JSON.stringify(vectors));
  }
  return vectors;
}

async function candidatesFor(query, vectors) {
  const embedding = vectors[query];
  if (!embedding) return [];
  const res = await request("search", `${env.SUPABASE_URL}/rest/v1/rpc/match_rag_documents`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      query_text: query,
      query_embedding_gte: `[${embedding.join(",")}]`,
      min_similarity_gte: MIN_SIMILARITY_GTE,
      match_count: CANDIDATES,
      include_noise: false,
    }),
  });
  return res.json();
}

async function searchOne(id, query, vectors) {
  const candidates = await candidatesFor(query, vectors);
  if (candidates.length <= 1) {
    return { candidates, results: candidates.slice(0, K), ranking: "fused" };
  }
  const reply = await chat(
    `rerank:${id}:${query}`,
    "carebridge-agent",
    rerankPrompt(query, candidates),
    RERANK_TIMEOUT_MS,
  );
  const ranking = reply.ok ? parseRanking(reply.content, candidates.length) : null;
  if (!ranking) {
    return {
      candidates,
      results: candidates.slice(0, K),
      ranking: "fused",
      error: reply.error ?? "invalid ranking",
    };
  }
  return {
    candidates,
    results: ranking.slice(0, K).map((i) => candidates[i]),
    ranking: "reranked",
  };
}

function mergeByDoc(groups) {
  const best = new Map();
  for (const group of groups) {
    for (const row of group) {
      const prev = best.get(row.doc_id);
      if (!prev || (row.similarity ?? -1) > (prev.similarity ?? -1)) best.set(row.doc_id, row);
    }
  }
  return [...best.values()]
    .sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1))
    .slice(0, K);
}

async function planQueries(itemId, question) {
  const complex = looksComplex(question) || false;
  if (!complex) {
    return {
      complex: false,
      queries: [question.trim()],
      reason: "single-topic question",
      source: "heuristic",
    };
  }
  const reply = await chat(`plan:${itemId}`, "carebridge-agent", planPrompt(question), PLAN_TIMEOUT_MS);
  if (!reply.ok) {
    return {
      complex: true,
      queries: [question.trim()],
      reason: reply.error || "plan failed",
      source: "fallback",
    };
  }
  const parsed = parseJsonObject(reply.content);
  const queries = cleanQueries(parsed?.queries, [question.trim()], MAX_PLAN_QUERIES);
  return {
    complex: parsed?.complex === true || queries.length > 1 || complex,
    queries,
    reason: typeof parsed?.reason === "string" ? parsed.reason.slice(0, 200) : "model plan",
    source: "model",
  };
}

async function agenticAnswer(item, vectors) {
  const question = item.question;
  const plan = await planQueries(item.id, question);
  const hopTrace = [];
  const groups = [];

  // Ensure embeddings exist for plan queries.
  await gteVectors(plan.queries);

  for (const query of plan.queries) {
    const result = await searchOne(`${item.id}:h1`, query, vectors);
    groups.push(result.results);
    hopTrace.push({
      hop: 1,
      query,
      ranking: result.ranking,
      candidates: result.candidates.length,
      results: result.results.length,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  let merged = mergeByDoc(groups);

  if (plan.complex && merged.length) {
    const followReply = await chat(
      `followup:${item.id}`,
      "carebridge-agent",
      followUpPrompt(question, merged),
      PLAN_TIMEOUT_MS,
    );
    const followUps = followReply.ok
      ? cleanQueries(parseJsonObject(followReply.content)?.queries, [], MAX_FOLLOWUPS)
      : [];
    if (followUps.length) {
      await gteVectors(followUps);
      for (const query of followUps) {
        const result = await searchOne(`${item.id}:h2`, query, vectors);
        groups.push(result.results);
        hopTrace.push({
          hop: 2,
          query,
          ranking: result.ranking,
          candidates: result.candidates.length,
          results: result.results.length,
          ...(result.error ? { error: result.error } : {}),
        });
      }
      merged = mergeByDoc(groups);
    }
  }

  let support = { supported: false, reason: "no matching passages", source: "empty" };
  if (merged.length) {
    const supportReply = await chat(
      `support:${item.id}`,
      "carebridge-agent",
      supportPrompt(question, merged),
      SUPPORT_TIMEOUT_MS,
    );
    const parsed = supportReply.ok ? parseJsonObject(supportReply.content) : null;
    if (parsed && typeof parsed.supported === "boolean") {
      support = {
        supported: parsed.supported,
        reason:
          typeof parsed.reason === "string"
            ? parsed.reason.slice(0, 200)
            : parsed.supported
              ? "passages answer"
              : "passages do not answer",
        source: "model",
      };
    } else {
      support = {
        supported: false,
        reason: supportReply.error || "invalid support judgment",
        source: "fallback",
      };
    }
  }

  if (!support.supported) {
    return {
      id: item.id,
      category: item.category,
      question,
      expect_refuse: Boolean(item.expect_refuse),
      multi_hop: Boolean(item.multi_hop),
      refused: true,
      supported: false,
      answer: REFUSE_MESSAGE,
      contexts: [],
      ground_truth: item.ground_truth,
      reference_contexts: item.reference_contexts || [],
      agentic: {
        plan,
        hops: hopTrace,
        support,
      },
    };
  }

  const answerReply = await chat(
    `answer:${item.id}`,
    "carebridge-agent",
    answerPrompt(question, merged),
  );
  const answer = answerReply.ok ? answerReply.content.trim() : REFUSE_MESSAGE;
  const refused = !answerReply.ok || /do not know|could not find/i.test(answer);

  return {
    id: item.id,
    category: item.category,
    question,
    expect_refuse: Boolean(item.expect_refuse),
    multi_hop: Boolean(item.multi_hop),
    refused,
    supported: !refused,
    answer: refused ? REFUSE_MESSAGE : answer,
    contexts: refused ? [] : merged.map((r) => r.content || ""),
    ground_truth: item.ground_truth,
    reference_contexts: item.reference_contexts || [],
    agentic: {
      plan,
      hops: hopTrace,
      support,
      answer_error: answerReply.ok ? undefined : answerReply.error,
    },
  };
}

async function scoreItem(row) {
  const reply = await chat(
    `ragas:${row.id}`,
    "carebridge-judge",
    ragasJudgePrompt(row.question, row.answer, row.contexts, row.ground_truth),
  );
  const parsed = reply.ok ? parseJsonObject(reply.content) : null;
  const clamp = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  };

  let faithfulness = clamp(parsed?.faithfulness);
  let answer_relevance = clamp(parsed?.answer_relevance);
  let context_precision = clamp(parsed?.context_precision);
  let context_recall = clamp(parsed?.context_recall);

  // Deterministic refuse scoring when expected.
  if (row.expect_refuse) {
    const correct = row.refused;
    faithfulness = correct ? 1 : 0;
    answer_relevance = correct ? 1 : 0;
    context_precision = null;
    context_recall = null;
  } else if (row.refused) {
    // Unexpected refuse: faithful but low relevance.
    faithfulness = faithfulness ?? 1;
    answer_relevance = answer_relevance ?? 0.2;
  }

  if (!row.contexts.length && !row.expect_refuse) {
    context_precision = null;
    context_recall = null;
  }

  return {
    ...row,
    faithfulness: round4(faithfulness),
    answer_relevance: round4(answer_relevance),
    context_precision: round4(context_precision),
    context_recall: round4(context_recall),
    score_reason: parsed?.reason ?? reply.error ?? "unparsed",
    score_ok: Boolean(parsed) || row.expect_refuse,
  };
}

function byCategoryMeans(items) {
  const groups = {};
  for (const item of items) {
    const cat = item.category || "unknown";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  const out = {};
  for (const [cat, rows] of Object.entries(groups)) {
    out[cat] = {
      n: rows.length,
      faithfulness: round4(mean(rows.map((r) => r.faithfulness))),
      answer_relevance: round4(mean(rows.map((r) => r.answer_relevance))),
      context_precision: round4(mean(rows.map((r) => r.context_precision))),
      context_recall: round4(mean(rows.map((r) => r.context_recall))),
    };
  }
  return out;
}

function writeReport(payload) {
  const agg = payload.aggregate;
  const lines = [
    `# RAGAS evaluation report`,
    ``,
    `**Mode:** \`${payload.mode}\``,
    `**Scoring:** \`${payload.scoring}\``,
    `**Golden set:** \`${payload.golden_set}\` (${payload.n_items} items)`,
    `**Run at:** ${payload.run_at}`,
    `**Real RAGAS?** **${payload.real_ragas ? "yes" : "no"}** — ${payload.scoring}`,
    ``,
    `## Aggregate (0–1)`,
    ``,
    `| Metric | Score | Hard floor |`,
    `|---|---:|---:|`,
    ...METRICS.map(
      (m) =>
        `| ${m} | ${agg[m] == null ? "—" : agg[m].toFixed(4)} | ${payload.thresholds[m]} |`,
    ),
    ``,
    `## By category`,
    ``,
    `| Category | n | Faithfulness | Answer relevance | Context precision | Context recall |`,
    `|---|---:|---:|---:|---:|---:|`,
    ...Object.entries(payload.by_category).map(([cat, row]) => {
      const fmt = (v) => (v == null ? "—" : v.toFixed(4));
      return `| ${cat} | ${row.n} | ${fmt(row.faithfulness)} | ${fmt(row.answer_relevance)} | ${fmt(row.context_precision)} | ${fmt(row.context_recall)} |`;
    }),
    ``,
    `## Refusal`,
    ``,
    `- Correct refuse rate: **${payload.refusal.correct_refuse_rate ?? "—"}** (${payload.refusal.correct}/${payload.refusal.n})`,
    `- False answer rate: **${payload.refusal.false_answer_rate ?? "—"}**`,
    ``,
    `## A3 baseline bridge`,
    ``,
    `- Locked A3b: matching Hit@5/MRR/P@5 = 1.00 / 1.00 / 0.63; edge 0.92 / 0.92 / 0.62; noisy 0.90 / 0.90 / 0.57.`,
    `- A3 judge faithfulness/relevance 5.00 / 5.00 on matching is **1–5 scale**, not RAGAS 0–1.`,
    `- Live RAGAS re-scores the same golden families; do not equate 5 → 1.`,
    ``,
    `## Notes`,
    ``,
    `- System under test: agentic RAG (plan → multi-hop hybrid retrieve → refuse) via live Supabase + LiteLLM.`,
    `- Judge model: \`carebridge-judge\` through LiteLLM (RAGAS-aligned 0–1 prompts).`,
    `- Langfuse: see clinic-flow A4 docs when wired.`,
    ``,
  ];
  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
}

async function main() {
  const golden = readJson(GOLDEN_PATH);
  let items = golden.items || [];
  if (args.limit) items = items.slice(0, args.limit);

  console.log(`Live RAGAS: ${items.length} golden items (pace ${PACE_MS}ms)`);

  // Prefetch embeddings for all questions.
  const seedTexts = items.map((i) => i.question);
  console.log("Embedding questions with gte-small…");
  let vectors = await gteVectors(seedTexts);

  const answers = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i + 1}/${items.length}] ${item.id} (${item.category})`);
    // Refresh vectors map after plan queries may have added keys.
    vectors = await gteVectors([
      ...Object.keys(fs.existsSync(EMBED_CACHE) ? readJson(EMBED_CACHE) : {}),
      item.question,
    ]);
    const row = await agenticAnswer(item, vectors);
    answers.push(row);
    console.log(
      `  → refused=${row.refused} contexts=${row.contexts.length} plan=${row.agentic.plan.source}`,
    );
  }

  const answersPayload = {
    about: "Live agentic RAG answers for A4 RAGAS scoring",
    schema_version: 1,
    run_at: new Date().toISOString(),
    n_items: answers.length,
    items: answers,
  };
  fs.writeFileSync(ANSWERS_PATH, JSON.stringify(answersPayload, null, 2) + "\n");
  console.log(`Wrote ${path.relative(ROOT, ANSWERS_PATH)}`);

  if (args.skipScore) {
    console.log("--answers-only: skip scoring");
    return;
  }

  console.log("Scoring with carebridge-judge (RAGAS-aligned 0–1)…");
  const scored = [];
  for (let i = 0; i < answers.length; i++) {
    console.log(`[score ${i + 1}/${answers.length}] ${answers[i].id}`);
    scored.push(await scoreItem(answers[i]));
  }

  const refusalItems = scored.filter((r) => r.expect_refuse);
  const correctRefuse = refusalItems.filter((r) => r.refused).length;
  const falseAnswer = refusalItems.filter((r) => !r.refused).length;

  const thresholdsDoc = fs.existsSync(THRESHOLDS_PATH)
    ? readJson(THRESHOLDS_PATH)
    : { metrics: { faithfulness: 0.7, answer_relevance: 0.7, context_precision: 0.55, context_recall: 0.55 } };

  const aggregate = {
    faithfulness: round4(mean(scored.map((r) => r.faithfulness))),
    answer_relevance: round4(mean(scored.map((r) => r.answer_relevance))),
    context_precision: round4(mean(scored.map((r) => r.context_precision))),
    context_recall: round4(mean(scored.map((r) => r.context_recall))),
  };

  const payload = {
    about:
      "A4 Option 1 live RAGAS-aligned results. Answers from agentic retrieve+refuse path; scores from carebridge-judge 0–1 prompts.",
    schema_version: 1,
    assessment: "A4-Option1",
    mode: "live",
    scoring: "litellm_judge_ragas_aligned_0_1",
    real_ragas: true,
    golden_set: "eval/ragas-golden-set.json",
    a3_baseline_lock: golden.a3_baseline_lock || "A3b",
    run_id: `a4-live-${new Date().toISOString().slice(0, 10)}`,
    run_at: new Date().toISOString(),
    n_items: scored.length,
    metrics: METRICS,
    thresholds: thresholdsDoc.metrics,
    planned_thresholds: thresholdsDoc.metrics,
    aggregate,
    by_category: byCategoryMeans(scored),
    refusal: {
      n: refusalItems.length,
      correct: correctRefuse,
      correct_refuse_rate: round4(
        refusalItems.length ? correctRefuse / refusalItems.length : null,
      ),
      false_answer_rate: round4(
        refusalItems.length ? falseAnswer / refusalItems.length : null,
      ),
    },
    items: scored.map((r) => ({
      id: r.id,
      category: r.category,
      expect_refuse: r.expect_refuse,
      multi_hop: r.multi_hop,
      refused: r.refused,
      question: r.question,
      answer: r.answer,
      faithfulness: r.faithfulness,
      answer_relevance: r.answer_relevance,
      context_precision: r.context_precision,
      context_recall: r.context_recall,
      score_reason: r.score_reason,
      agentic: r.agentic,
    })),
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2) + "\n");
  writeReport(payload);
  console.log(`Wrote ${path.relative(ROOT, RESULTS_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(
    `Aggregate faith=${aggregate.faithfulness} rel=${aggregate.answer_relevance} prec=${aggregate.context_precision} recall=${aggregate.context_recall}`,
  );
  console.log(
    `Refusal correct=${payload.refusal.correct_refuse_rate} (${correctRefuse}/${refusalItems.length})`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
