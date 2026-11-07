// 向量接口：地址补全、拉模型、连通性检查、真实调用测试、召回。
// 端点拼法照温柔乡 app/vector_memory_store.py 的 _embedding_url / _models_url：
// 填 https://api.xxx.cn/v1 或 https://api.xxx.cn 或完整 .../embeddings 都能用。

export function embeddingUrl(apiUrl) {
  let cleaned = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  if (cleaned.endsWith('/embeddings')) return cleaned;
  if (cleaned.includes('googleapis.com') && cleaned.includes('openai')) return cleaned + '/embeddings';
  if (!cleaned.endsWith('/v1')) cleaned += '/v1';
  return cleaned + '/embeddings';
}

export function modelsUrl(apiUrl) {
  let cleaned = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  if (cleaned.includes('/v1/')) cleaned = cleaned.split('/v1/')[0] + '/v1';
  else if (!cleaned.endsWith('/v1')) cleaned += '/v1';
  return cleaned + '/models';
}

export function rerankUrl(rawUrl) {
  const cleaned = String(rawUrl || '').trim().replace(/\/+$/, '');
  return cleaned;
}

export function checkUrl(rawUrl, kind = 'embedding') {
  const raw = String(rawUrl || '').trim();
  if (!raw) return { ok: false, error: '地址为空' };
  let parsed;
  try { parsed = new URL(raw); } catch { return { ok: false, error: '不是合法 URL（要带 http:// 或 https://）' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: '协议必须是 http 或 https' };
  if (!parsed.hostname) return { ok: false, error: '没有主机名' };
  const derived = kind === 'rerank' ? rerankUrl(raw) : embeddingUrl(raw);
  return {
    ok: true,
    input: raw,
    endpoint: derived,
    models: kind === 'rerank' ? null : modelsUrl(raw),
    localhost: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(parsed.hostname),
  };
}

function authHeaders(key) {
  const headers = { 'content-type': 'application/json' };
  if (String(key || '').trim()) headers.authorization = 'Bearer ' + String(key).trim();
  return headers;
}

async function readError(response) {
  let text = '';
  try { text = (await response.text()).slice(0, 300); } catch { /* ignore */ }
  return `HTTP ${response.status}${text ? '：' + text : ''}`;
}

export async function fetchModels(apiUrl, key) {
  const url = modelsUrl(apiUrl);
  if (!url) throw new Error('请先填 Embedding 地址');
  const started = Date.now();
  const response = await fetch(url, { headers: authHeaders(key), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json().catch(() => null);
  const data = payload && Array.isArray(payload.data) ? payload.data : null;
  if (!data) throw new Error('模型接口没返回 data 数组（有些聚合商不提供 /models，手填模型即可）');
  const ids = [...new Set(data.map((item) => String(item?.id || '').trim()).filter(Boolean))].sort();
  if (!ids.length) throw new Error('接口返回了 data，但没有模型 id');
  return { models: ids, endpoint: url, ms: Date.now() - started };
}

export async function testEmbedding(vector, text = 'WRX 向量连接测试') {
  const url = embeddingUrl(vector?.apiUrl);
  const model = String(vector?.model || '').trim();
  if (!url) throw new Error('请先填 Embedding 地址');
  if (!model) throw new Error('请先填 Embedding 模型');
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(vector?.apiKey),
    body: JSON.stringify({ model, input: [text] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json().catch(() => null);
  const data = payload && Array.isArray(payload.data) ? payload.data : null;
  if (!data || !data.length) throw new Error('返回里没有 data 数组');
  const vectorOut = data[0]?.embedding;
  if (!Array.isArray(vectorOut) || !vectorOut.length) throw new Error('返回里没有可用向量');
  return { ms: Date.now() - started, dimensions: vectorOut.length, endpoint: url, model };
}

export async function testRerank(vector) {
  const url = rerankUrl(vector?.rerankUrl);
  const model = String(vector?.rerankModel || '').trim();
  if (!url) throw new Error('请先填 Rerank 地址');
  if (!model) throw new Error('请先填 Rerank 模型');
  const docs = ['DSH 是 DeepSeek Harness', '今天天气不错'];
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(vector?.rerankKey),
    body: JSON.stringify({ model, query: 'DSH 是什么', documents: docs, top_n: docs.length, return_documents: false }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json().catch(() => null);
  const results = payload && Array.isArray(payload.results) ? payload.results : null;
  if (!results) throw new Error('返回里没有 results 数组');
  return {
    ms: Date.now() - started,
    endpoint: url,
    model,
    scores: results.map((item) => ({ index: item?.index, score: item?.relevance_score ?? item?.score })),
  };
}

/** 把文字批量向量化（每批 32 条，跟温柔乡一致）。 */
export async function embedTexts(vector, texts, batchSize = 32) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const url = embeddingUrl(vector?.apiUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(vector?.apiKey),
      body: JSON.stringify({ model: vector.model, input: batch }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json();
    const data = payload?.data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error('返回向量数量与输入不一致');
    const ordered = [...data].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    for (const item of ordered) {
      if (!Array.isArray(item?.embedding) || !item.embedding.length) throw new Error('返回向量为空');
      out.push(item.embedding.map(Number));
    }
  }
  return out;
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : -1;
}

export async function rerankDocs(vector, query, documents) {
  const url = rerankUrl(vector?.rerankUrl);
  const model = String(vector?.rerankModel || '').trim();
  if (!url || !model) throw new Error('Rerank 未配置');
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(vector?.rerankKey),
    body: JSON.stringify({ model, query, documents, top_n: documents.length, return_documents: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json();
  if (!Array.isArray(payload?.results)) throw new Error('Rerank 没有返回 results');
  const scores = new Array(documents.length).fill(null);
  for (const item of payload.results) {
    const index = Number(item?.index);
    const score = item?.relevance_score ?? item?.score;
    if (Number.isInteger(index) && index >= 0 && index < scores.length && typeof score === 'number') scores[index] = score;
  }
  if (scores.some((v) => v === null)) throw new Error('Rerank 返回的索引不完整');
  return scores;
}

/**
 * 冷记忆召回：先按 cosine 粗排，阈值过滤取 K 条；
 * 启用 rerank 时先取 2K 条粗排候选做精排，失败退回纯向量排序（同温柔乡）。
 */
export async function recall(vector, query, rows, { topK = 16, threshold = 0.3 } = {}) {
  const withVector = (rows || []).filter((row) => Array.isArray(row.vector) && row.vector.length);
  if (!vector?.enabled || !withVector.length || !String(query || '').trim()) return [];
  const [queryVector] = await embedTexts(vector, [query]);
  const ranked = withVector
    .map((row) => ({ row, score: cosine(queryVector, row.vector) }))
    .sort((a, b) => b.score - a.score);
  const k = Math.max(1, Number(topK) || 16);
  const rerankOn = Boolean(vector.rerankEnabled);
  const initialThreshold = rerankOn ? 0.1 : Math.max(0, Number(threshold) || 0.3);
  const pool = rerankOn ? k * 2 : k;
  const picked = ranked.filter((item) => item.score >= initialThreshold).slice(0, pool);
  if (rerankOn && picked.length) {
    try {
      const scores = await rerankDocs(vector, query, picked.map((item) => item.row.content || item.row.history || item.row.description || ''));
      picked.forEach((item, i) => { item.vectorScore = item.score; item.score = scores[i]; item.rerank = 'applied'; });
      picked.sort((a, b) => b.score - a.score);
    } catch (error) {
      for (const item of picked) { item.rerank = 'fallback'; item.rerankError = String(error?.message || error); }
    }
  }
  const finalThreshold = rerankOn ? 0.001 : Math.max(0, Number(threshold) || 0.3);
  return picked.filter((item) => item.score >= finalThreshold).slice(0, k);
}
