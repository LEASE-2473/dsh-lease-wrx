// 冷记忆的「向量化落库」和「每轮召回」。
// 温柔乡里这两步是分开的两个脚本，移植时只搬了 vectorapi.recall，没搬调用方：
// 结果就是记忆转冷之后既没向量、也没人召，等于关进小黑屋。
import { loadConfig } from '../common/config.js';
import { rowsMissingVector, rowsWithVector, saveVector } from './common/vectors.js';
import { embedTexts, recall } from '../providers/vectorapi.js';

const MIN_BLOCK_CHARS = 0;
const MAX_BLOCK_CHARS = 1400;
const MAX_LINE_CHARS = 400;

let inflight = null;

/** 给还没算向量的记忆补向量（含冷记录）。同一角色同时只会有一批在跑。 */
export function backfillVectors(characterId, { limit = 400 } = {}) {
  if (inflight && inflight.character === characterId) return inflight.promise;
  const promise = runBackfill(characterId, limit).finally(() => {
    if (inflight && inflight.promise === promise) inflight = null;
  });
  inflight = { character: characterId, promise };
  return promise;
}

async function runBackfill(characterId, limit) {
  const cfg = loadConfig();
  if (!cfg.vector?.enabled) return { enabled: false, done: 0, left: null, error: '向量记忆未启用' };
  const missing = rowsMissingVector(characterId);
  if (!missing.length) return { enabled: true, done: 0, left: 0 };
  const batch = missing.slice(0, Math.max(1, Number(limit) || 400));
  const vectors = await embedTexts(cfg.vector, batch.map((row) => row.text));
  let done = 0;
  for (let i = 0; i < batch.length; i += 1) {
    try {
      const changed = saveVector(characterId, batch[i].id, vectors[i], cfg.vector.model);
      if (changed) done += 1;
    } catch { /* 单条失败不拖垮整批 */ }
  }
  return { enabled: true, done, left: rowsMissingVector(characterId).length };
}

/** 召回行的时间前缀：冷记忆也得知道是什么时候的事。 */
function fmtWhen(row) {
  const raw = String(row?.range_start || row?.occurred_at || row?.created_at || row?.diary_date || '');
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 16).replace('T', ' ');
  try {
    const tz = loadConfig().timezone || 'Asia/Shanghai';
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  } catch {
    return raw.slice(0, 16).replace('T', ' ');
  }
}

/**
 * 用这一轮的用户输入去召回冷记忆，拼成一段可注入的文本。
 * rerank 生效时按精排分数再筛一遍，避免把一堆不相关的塞进去。
 * allowKinds：按注入开关只召回指定类别（summary/person/item/agreement/diary/activity）。
 */
export async function recallBlock(characterId, query, { topK, threshold, allowKinds } = {}) {
  const cfg = loadConfig();
  if (!cfg.vector?.enabled) return { text: '', hits: [] };
  const q = String(query || '').trim();
  if (!q) return { text: '', hits: [] };
  const allow = Array.isArray(allowKinds) ? allowKinds : null;
  const rows = rowsWithVector(characterId).filter((row) => !allow || allow.includes(row.kind));
  if (!rows.length) return { text: '', hits: [] };
  const k = Math.max(1, Number(topK) || Number(cfg.vector.maxResults) || 8);
  const th = Number.isFinite(Number(threshold)) ? Number(threshold) : (Number(cfg.vector.threshold) || 0.3);
  const hits = await recall(
    cfg.vector,
    q,
    rows.map((row) => ({ ...row, content: row.text })),
    { topK: k, threshold: th },
  );
  const stillEligible = new Set(rowsWithVector(characterId).map(row => row.id));
  const kept = hits.filter((item) => {
    if (!stillEligible.has(item.row?.id)) return false;
    const score = Number(item.score);
    if (!Number.isFinite(score)) return false;
    // rerank 分数跟向量余弦不是一个量纲（这个 rerank 模型给中文长句的分普遍很低），
    // 粗排已按 threshold 筛过，所以精排只负责排序，不拿绝对分数再砍一刀。
    return item.rerank === 'applied' ? score >= 0 : score >= th;
  });
  const lines = [];
  let used = 0;
  for (const item of kept) {
    const body = String(item.row?.text || item.row?.content || '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    // 一条记忆就是一个召回单位，整条注入，不按字数切。
    // 预算只决定「还塞不塞得下下一条」，不切当前这条。
    const when = fmtWhen(item.row);
    const line = (when ? '[' + when + '] ' : '') + body;
    if (lines.length && used + line.length + 2 > MAX_BLOCK_CHARS) break;
    lines.push('· ' + line);
    used += line.length + 2;
  }
  if (!lines.length) return { text: '', hits: [] };
  const text = '# 长期记忆（按当前话题向量召回，含冷记录）\n'
    + '下面是过去发生过、和这一轮话题相关的事实。只用它们核对事实和延续情绪，不要逐条复述，也不要当成新消息。\n'
    + lines.join('\n');
  return {
    text: text.length > MIN_BLOCK_CHARS ? text : '',
    hits: kept.map((item) => ({
      id: item.row?.id,
      kind: item.row?.kind,
      score: Number(item.score),
      rerank: item.rerank || 'none',
      text: String(item.row?.text || '').slice(0, 120),
    })),
  };
}

export function recallStats(characterId) {
  return {
    vectorized: rowsWithVector(characterId).length,
    missing: rowsMissingVector(characterId).length,
  };
}
