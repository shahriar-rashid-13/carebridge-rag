// RAG retrieval evaluation for CareBridge (Assessment 2, Track 3).
//
// Query sets: matching and edge come from eval/rag-queries.json; noisy is generated here from the
// matching set (typos plus junk tokens). Each set runs against the clean index and the index with
// noise rows (is_noise = true), in hybrid mode (with a query embedding) and keyword-only mode.
//
// Usage: node scripts/rag-eval.mjs [--model gemini|gte] [--seed-noise] [--cutoff X] [--sweep a,b,c]
//   --model       gemini (default, Assessment 2: gemini-embedding-001 via LiteLLM) or gte
//                 (Supabase/gte-small computed locally, searched through embedding_gte)
//   --seed-noise  embed and upsert the noise rows (NOISE-xxxx) that have no embedding for the model yet
//   --cutoff X    minimum cosine similarity for semantic matches (default 0.55 gemini, 0.80 gte)
//   --sweep list  only run hybrid mode at each cutoff in the list and write eval/<model>-cutoff-sweep.json
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from .env, plus LITELLM_BASE_URL and
// LITELLM_MASTER_KEY for gemini. Writes eval/rag-eval-results.json and eval/RAG_EVAL_REPORT.md
// (gemini) or eval/rag-eval-results-gte.json and eval/RAG_EVAL_REPORT_GTE.md (gte).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus", "corpus_clean.jsonl");
const EVAL_DIR = path.join(ROOT, "eval");

const MODELS = {
  gemini: {
    label: "gemini-embedding-001 (768 dims) via LiteLLM carebridge-embed",
    column: "embedding",
    queryParam: "query_embedding",
    cutoffParam: "min_similarity",
    defaultCutoff: 0.55,
    cache: path.join(EVAL_DIR, ".cache", "query-embeddings.json"),
    results: "rag-eval-results.json",
    report: "RAG_EVAL_REPORT.md",
  },
  gte: {
    label: "Supabase/gte-small (384 dims), local transformers.js for documents and queries",
    column: "embedding_gte",
    queryParam: "query_embedding_gte",
    cutoffParam: "min_similarity_gte",
    defaultCutoff: 0.8,
    cache: path.join(EVAL_DIR, ".cache", "query-embeddings-gte.json"),
    results: "rag-eval-results-gte.json",
    report: "RAG_EVAL_REPORT_GTE.md",
  },
};
let MODEL = MODELS.gemini;
let CUTOFF = MODEL.defaultCutoff;
const K = 5;
const SEED = 20261001;
const NOISE_PER_TYPE = 100;
const EMBED_BATCH = 50;
const EMBED_PACE_MS = 31000;

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  if (MODEL === MODELS.gemini) required.push("LITELLM_BASE_URL", "LITELLM_MASTER_KEY");
  for (const key of required) {
    if (!env[key]) throw new Error(`${key} missing in .env`);
  }
  return env;
}

function parseArgs(argv) {
  const args = { flags: new Set(), sweep: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") {
      MODEL = MODELS[argv[++i]];
      if (!MODEL) throw new Error("--model must be gemini or gte");
      CUTOFF = MODEL.defaultCutoff;
    } else if (argv[i] === "--cutoff") args.cutoff = Number(argv[++i]);
    else if (argv[i] === "--sweep") args.sweep = argv[++i].split(",").map(Number);
    else args.flags.add(argv[i]);
  }
  if (args.cutoff !== undefined) CUTOFF = args.cutoff;
  return args;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY_NEIGHBOURS = {
  a: "sq", b: "vn", c: "xv", d: "sf", e: "wr", f: "dg", g: "fh", h: "gj", i: "uo", j: "hk", k: "jl", l: "k",
  m: "n", n: "bm", o: "ip", p: "o", q: "w", r: "et", s: "ad", t: "ry", u: "yi", v: "cb", w: "qe", x: "zc",
  y: "tu", z: "x",
};
const JUNK_TOKENS = ["asdf", "qwe!!", "zzkx", "lol", "###", "...", "xD", "1234", "~~", "hmm??", "plz", "@@"];

function typoWord(rand, word) {
  if (word.length < 4) return word;
  const i = 1 + Math.floor(rand() * (word.length - 2));
  const op = Math.floor(rand() * 4);
  if (op === 0) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  if (op === 1) return word.slice(0, i) + word.slice(i + 1);
  if (op === 2) return word.slice(0, i) + word[i] + word.slice(i);
  const near = KEY_NEIGHBOURS[word[i].toLowerCase()];
  return near ? word.slice(0, i) + pick(rand, near) + word.slice(i + 1) : word;
}

function addTypos(rand, text, rate) {
  return text
    .split(" ")
    .map((w) => (rand() < rate ? typoWord(rand, w) : w))
    .join(" ");
}

function addJunk(rand, text, count) {
  const words = text.split(" ");
  for (let n = 0; n < count; n++) {
    words.splice(Math.floor(rand() * (words.length + 1)), 0, pick(rand, JUNK_TOKENS));
  }
  return words.join(" ");
}

function noisyQueries(matching) {
  const rand = rng(SEED);
  return matching.map((q) => ({
    id: q.id.replace("M", "N"),
    from: q.id,
    query: addJunk(rand, addTypos(rand, q.query, 0.35), 2),
    relevant: q.relevant,
  }));
}

const OFF_TOPIC = {
  cricket: ["The batsman scored a century before lunch on the second day of the test match.", "Spin bowlers usually get more turn on a dry pitch in the afternoon.", "The captain chose to bowl first after winning the toss under cloudy skies."],
  cooking: ["Fry the onions until golden, then add ginger, garlic, and the spice mix.", "Soak the rice for thirty minutes before cooking for a softer texture.", "Add the fish only after the mustard paste starts to bubble."],
  cars: ["Change the engine oil every five thousand kilometres and check the filter.", "A squeaking sound when braking usually means the pads are worn.", "Keep the tyre pressure at the level printed inside the driver door."],
  phones: ["To free up storage, clear the app cache and move photos to the cloud.", "Restart the phone if the screen freezes after the latest update.", "Battery life improves when background refresh is turned off."],
  travel: ["The ferry leaves the river terminal at seven in the morning during winter.", "Book train tickets early during the Eid holidays because they sell out fast.", "Carry a light jacket because hill stations get cold at night."],
  finance: ["The stock index closed higher after strong results from the banking sector.", "Fixed deposits offer a steady return but lock your money for a term.", "Compare the exchange rate before sending money abroad."],
  weather: ["Heavy rain is expected across the coastal districts over the weekend.", "Fog may delay morning flights during the winter months.", "Temperatures will rise again after the cold wave passes."],
  movies: ["The film's second half drags, but the soundtrack is excellent.", "The sequel opens in cinemas next Friday with a late-night premiere.", "Critics praised the lead actor for his quiet, natural performance."],
  gardening: ["Water tomato plants early in the morning and keep the soil mulched.", "Prune rose bushes after flowering to encourage new growth.", "Use compost instead of chemical fertiliser for leafy vegetables."],
  software: ["Run the migration before deploying the new version of the API.", "The build failed because a dependency version was not pinned.", "Clear the browser cache if the old stylesheet still loads."],
};
const JUNK_VOCAB = [
  "fever", "pain", "appointment", "bill", "doctor", "cough", "rash", "waitlist", "refund", "headache",
  "medicine", "booking", "reminder", "eyes", "throat", "sleep", "chest", "account", "invoice", "clinic",
];

function noiseRows(corpus, queries) {
  const rand = rng(SEED + 1);
  const byId = new Map(corpus.map((r) => [r.doc_id, r]));
  const sources = [];
  const seen = new Set();
  const addSource = (id) => {
    const r = byId.get(id);
    if (r && !seen.has(id) && r.rag_visible !== false) {
      seen.add(id);
      sources.push(r);
    }
  };
  for (const q of [...queries.matching, ...queries.edge]) for (const id of q.relevant?.faq ?? []) addSource(id);
  const diagnoses = [...new Set(corpus.filter((r) => r.record_type === "prescription").map((r) => r.diagnosis))];
  for (let round = 0; sources.length < NOISE_PER_TYPE && round < 5; round++) {
    for (const dx of diagnoses) {
      if (sources.length >= NOISE_PER_TYPE) break;
      const rx = corpus.filter((r) => r.record_type === "prescription" && r.diagnosis === dx && r.doc_id <= "RX-001730");
      if (rx[round]) addSource(rx[round].doc_id);
    }
  }

  const rows = [];
  const id = () => `NOISE-${String(rows.length + 1).padStart(4, "0")}`;
  for (const src of sources.slice(0, NOISE_PER_TYPE)) {
    rows.push({
      doc_id: id(), record_type: src.record_type, content: addJunk(rand, addTypos(rand, src.content, 0.5), 4),
      specialization: src.specialization, diagnosis: null, faq_topic: src.faq_topic,
      rag_visible: true, is_noise: true, noise_type: "typo_duplicate", source_doc_id: src.doc_id,
    });
  }
  const types = ["faq", "visit_note", "prescription"];
  for (let n = 0; n < NOISE_PER_TYPE; n++) {
    const len = 20 + Math.floor(rand() * 30);
    const words = Array.from({ length: len }, () => {
      const roll = rand();
      if (roll < 0.35) return pick(rand, JUNK_VOCAB);
      if (roll < 0.7) return pick(rand, JUNK_TOKENS);
      return Math.floor(rand() * 100000).toString(36);
    });
    rows.push({
      doc_id: id(), record_type: types[n % 3], content: words.join(" "),
      specialization: null, diagnosis: null, faq_topic: null,
      rag_visible: true, is_noise: true, noise_type: "junk", source_doc_id: null,
    });
  }
  const topics = Object.keys(OFF_TOPIC);
  for (let n = 0; n < NOISE_PER_TYPE; n++) {
    const topic = topics[n % topics.length];
    const sentences = [...OFF_TOPIC[topic]].sort(() => rand() - 0.5).slice(0, 2 + (n % 2));
    rows.push({
      doc_id: id(), record_type: types[n % 3], content: sentences.join(" "),
      specialization: null, diagnosis: null, faq_topic: null,
      rag_visible: true, is_noise: true, noise_type: "off_topic", source_doc_id: null,
    });
  }
  return rows;
}

function supabaseHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function request(label, url, init) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const wait = Math.min(5000 * 2 ** (attempt - 1), 90000);
      console.log(`  ${label}: HTTP ${res.status}, retry in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${label} failed with HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function embed(env, texts) {
  const res = await request("embed", `${env.LITELLM_BASE_URL.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "carebridge-embed", input: texts }),
  });
  const json = await res.json();
  return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

let gteExtractor = null;
async function embedGte(texts) {
  if (!gteExtractor) {
    const { pipeline } = await import("@huggingface/transformers");
    gteExtractor = await pipeline("feature-extraction", "Supabase/gte-small", { dtype: "fp32" });
  }
  return (await gteExtractor(texts, { pooling: "mean", normalize: true })).tolist();
}

async function embedAll(env, texts, onBatch) {
  const out = [];
  const gte = MODEL === MODELS.gte;
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    if (i > 0 && !gte) await sleep(EMBED_PACE_MS);
    const slice = texts.slice(i, i + EMBED_BATCH);
    const vectors = gte ? await embedGte(slice) : await embed(env, slice);
    out.push(...vectors);
    if (onBatch) await onBatch(i, vectors);
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, texts.length)}/${texts.length}`);
  }
  return out;
}

async function seedNoise(env, rows) {
  const res = await request(
    "read noise",
    `${env.SUPABASE_URL}/rest/v1/rag_documents?select=doc_id&is_noise=is.true&${MODEL.column}=not.is.null&limit=10000`,
    { headers: supabaseHeaders(env) },
  );
  const done = new Set((await res.json()).map((r) => r.doc_id));
  const pending = rows.filter((r) => !done.has(r.doc_id));
  console.log(`Noise rows: ${rows.length}, already embedded ${done.size}, to upload ${pending.length}`);
  await embedAll(env, pending.map((r) => r.content), async (offset, vectors) => {
    const batch = pending
      .slice(offset, offset + vectors.length)
      .map((r, j) => ({ ...r, [MODEL.column]: `[${vectors[j].join(",")}]` }));
    await request("upsert noise", `${env.SUPABASE_URL}/rest/v1/rag_documents?on_conflict=doc_id`, {
      method: "POST",
      headers: { ...supabaseHeaders(env), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    });
  });
}

async function queryEmbeddings(env, texts) {
  const cache = fs.existsSync(MODEL.cache) ? JSON.parse(fs.readFileSync(MODEL.cache, "utf8")) : {};
  const missing = [...new Set(texts.filter((t) => !cache[t]))];
  if (missing.length) {
    console.log(`Embedding ${missing.length} queries`);
    const vectors = await embedAll(env, missing);
    missing.forEach((t, i) => (cache[t] = vectors[i]));
    fs.mkdirSync(path.dirname(MODEL.cache), { recursive: true });
    fs.writeFileSync(MODEL.cache, JSON.stringify(cache));
  }
  return cache;
}

async function search(env, text, embedding, includeNoise, cutoff = CUTOFF) {
  const res = await request("search", `${env.SUPABASE_URL}/rest/v1/rpc/match_rag_documents`, {
    method: "POST",
    headers: supabaseHeaders(env),
    body: JSON.stringify({
      query_text: text,
      [MODEL.queryParam]: embedding ? `[${embedding.join(",")}]` : null,
      [MODEL.cutoffParam]: cutoff,
      match_count: K,
      include_noise: includeNoise,
    }),
  });
  return res.json();
}

function judge(q, results) {
  const isNoise = (r) => r.doc_id.startsWith("NOISE-");
  const relevant = (r) =>
    !isNoise(r) && ((q.relevant?.faq ?? []).includes(r.doc_id) || (q.relevant?.diagnosis ?? []).includes(r.diagnosis));
  const flags = results.map(relevant);
  const first = flags.indexOf(true);
  return {
    returned: results.length,
    hit: first >= 0 ? 1 : 0,
    rr: first >= 0 ? 1 / (first + 1) : 0,
    p_at_k: flags.filter(Boolean).length / K,
    noise_in_top_k: results.filter(isNoise).length,
    top: results.map((r) => `${r.doc_id}${relevant(r) ? "*" : ""}`),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x) => x.toFixed(2);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const corpus = fs.readFileSync(CORPUS, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const queries = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "rag-queries.json"), "utf8"));
  const sets = { matching: queries.matching, edge: queries.edge, noisy: noisyQueries(queries.matching) };

  const noise = noiseRows(corpus, queries);
  if (args.flags.has("--dry-run")) {
    for (const t of ["typo_duplicate", "junk", "off_topic"]) {
      const sample = noise.filter((r) => r.noise_type === t).slice(0, 2);
      for (const r of sample) console.log(`${r.doc_id} ${t} ${r.source_doc_id ?? ""}: ${r.content.slice(0, 160)}`);
    }
    for (const q of sets.noisy.slice(0, 5)) console.log(`${q.id}: ${q.query}`);
    return;
  }
  if (args.flags.has("--seed-noise")) await seedNoise(env, noise);

  const count = async (isNoise) => {
    const res = await request(
      "count",
      `${env.SUPABASE_URL}/rest/v1/rag_documents?select=doc_id&${MODEL.column}=not.is.null&is_noise=is.${isNoise}&limit=1`,
      { headers: { ...supabaseHeaders(env), Prefer: "count=exact" } },
    );
    return Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
  };
  const index = { clean: await count(false), noise: await count(true) };
  console.log(`Index: ${index.clean} clean rows, ${index.noise} noise rows`);

  const allTexts = Object.values(sets).flat().map((q) => q.query);
  const vectors = await queryEmbeddings(env, allTexts);

  if (args.sweep) {
    const sweep = [];
    for (const cutoff of args.sweep) {
      const { summary } = await evaluate(env, sets, vectors, [{ mode: "hybrid", includeNoise: false }], cutoff, false);
      const answerable = summary.filter((s) => s.queries > 0);
      const oos = summary.filter((s) => s.out_of_scope > 0);
      const entry = {
        cutoff,
        sets: Object.fromEntries(summary.map((s) => [s.set, { hit_rate: s.hit_rate, mrr: s.mrr, p_at_k: s.p_at_k }])),
        mean_hit_rate: mean(answerable.map((s) => s.hit_rate)),
        mean_mrr: mean(answerable.map((s) => s.mrr)),
        out_of_scope_empty: `${oos.reduce((a, s) => a + s.correct_empty, 0)} of ${oos.reduce((a, s) => a + s.out_of_scope, 0)}`,
      };
      sweep.push(entry);
      console.log(
        `cutoff ${cutoff.toFixed(2)}  ${summary.map((s) => `${s.set} hit ${fmt(s.hit_rate)} mrr ${fmt(s.mrr)}`).join("  ")}  out-of-scope empty ${entry.out_of_scope_empty}`,
      );
    }
    const file = path.join(EVAL_DIR, `${MODEL === MODELS.gte ? "gte" : "gemini"}-cutoff-sweep.json`);
    fs.writeFileSync(file, JSON.stringify({ run_at: new Date().toISOString(), model: MODEL.label, index, sweep }, null, 2));
    console.log(`Wrote ${path.relative(ROOT, file)}`);
    return;
  }

  const configs = [
    { mode: "hybrid", includeNoise: false },
    { mode: "hybrid", includeNoise: true },
    { mode: "keyword_only", includeNoise: false },
    { mode: "keyword_only", includeNoise: true },
  ];
  const { summary, details } = await evaluate(env, sets, vectors, configs, CUTOFF, true);

  const result = {
    run_at: new Date().toISOString(),
    k: K,
    embedding_model: MODEL.label,
    search: `match_rag_documents: cosine >= ${CUTOFF} or trigram >= 0.6, fused with full text by reciprocal rank fusion`,
    index,
    noise_rows: { typo_duplicate: NOISE_PER_TYPE, junk: NOISE_PER_TYPE, off_topic: NOISE_PER_TYPE },
    noisy_queries: sets.noisy.map((q) => ({ id: q.id, from: q.from, query: q.query })),
    summary,
    details,
  };
  fs.writeFileSync(path.join(EVAL_DIR, MODEL.results), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(EVAL_DIR, MODEL.report), report(result, sets));
  console.log(`Wrote eval/${MODEL.results} and eval/${MODEL.report}`);
}

async function evaluate(env, sets, vectors, configs, cutoff, log) {
  const details = [];
  const summary = [];
  for (const [setName, list] of Object.entries(sets)) {
    for (const cfg of configs) {
      const rows = [];
      for (const q of list) {
        const results = await search(env, q.query, cfg.mode === "hybrid" ? vectors[q.query] : null, cfg.includeNoise, cutoff);
        const j = judge(q, results);
        rows.push({ q, j });
        details.push({ set: setName, mode: cfg.mode, index: cfg.includeNoise ? "with_noise" : "clean", id: q.id, query: q.query, ...j });
      }
      const answerable = rows.filter((r) => !r.q.expect_empty);
      const outOfScope = rows.filter((r) => r.q.expect_empty);
      summary.push({
        set: setName,
        mode: cfg.mode,
        index: cfg.includeNoise ? "with_noise" : "clean",
        queries: answerable.length,
        hit_rate: mean(answerable.map((r) => r.j.hit)),
        mrr: mean(answerable.map((r) => r.j.rr)),
        p_at_k: mean(answerable.map((r) => r.j.p_at_k)),
        noise_share: mean(answerable.map((r) => r.j.noise_in_top_k / K)),
        out_of_scope: outOfScope.length,
        correct_empty: outOfScope.filter((r) => r.j.returned === 0).length,
      });
      const s = summary.at(-1);
      if (log) {
        console.log(`${setName.padEnd(8)} ${cfg.mode.padEnd(12)} ${s.index.padEnd(10)} hit ${fmt(s.hit_rate)} mrr ${fmt(s.mrr)} p@5 ${fmt(s.p_at_k)} noise ${fmt(s.noise_share)}`);
      }
    }
  }
  return { summary, details };
}

function report(r, sets) {
  const row = (s) =>
    `| ${s.set} | ${s.mode} | ${s.index} | ${s.queries} | ${fmt(s.hit_rate)} | ${fmt(s.mrr)} | ${fmt(s.p_at_k)} | ${fmt(s.noise_share)} |`;
  const oos = r.summary.filter((s) => s.out_of_scope > 0);
  const failures = r.details.filter((d) => d.mode === "hybrid" && !sets[d.set].find((q) => q.id === d.id)?.expect_empty && d.hit === 0);
  return `# CareBridge RAG evaluation

Run: ${r.run_at} · k = ${r.k} · ${r.embedding_model}

Search: ${r.search}.

Index: ${r.index.clean} clean embedded rows plus ${r.index.noise} noise rows
(${r.noise_rows.typo_duplicate} typo duplicates of real records, ${r.noise_rows.junk} junk rows, ${r.noise_rows.off_topic} off-topic rows).
"clean" excludes noise rows (\`include_noise = false\`, what the app uses); "with_noise" includes them.

Metrics (answerable queries only):

- hit_rate: share of queries with at least one relevant result in the top ${r.k}.
- mrr: mean reciprocal rank of the first relevant result.
- p@${r.k}: relevant results in the top ${r.k} divided by ${r.k}. Single-answer FAQ queries can score at most 0.2 to 0.4.
- noise: share of top-${r.k} slots taken by noise rows.

| Set | Mode | Index | Queries | Hit rate | MRR | P@${r.k} | Noise in top ${r.k} |
|---|---|---|---|---|---|---|---|
${r.summary.map(row).join("\n")}

Out-of-scope queries (correct answer is no result):

| Mode | Index | Returned nothing |
|---|---|---|
${oos.map((s) => `| ${s.mode} | ${s.index} | ${s.correct_empty} of ${s.out_of_scope} |`).join("\n")}

Hybrid-mode misses (no relevant result in the top ${r.k}):

${failures.length ? failures.map((d) => `- ${d.set}/${d.index} ${d.id}: "${d.query}" returned ${d.top.join(", ") || "nothing"}`).join("\n") : "- none"}

Noisy queries (generated from the matching set, seed ${SEED}):

${r.noisy_queries.map((q) => `- ${q.id} (from ${q.from}): ${q.query}`).join("\n")}
`;
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  process.exit(1);
});
