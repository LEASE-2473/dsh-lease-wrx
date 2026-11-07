/** WRX Companion memory/system_protocol.py 的 JS 提取：四表提案与冷记录读取协议。 */
import { FIELDS } from './schema.js';

const GROUPS = { people: 'person', items: 'item' };

export function parseInitial(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('```') && text.endsWith('```')) text = text.replace(/^```[^\n]*\n/, '').replace(/```$/, '').trim();
  if (!text.startsWith('{')) throw new Error('初次整理必须先返回四表 JSON');
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('四表 JSON 不完整');
  const document = JSON.parse(text.slice(0, end));
  const tail = text.slice(end).trim();
  if (!tail) return { document, recall: {} };
  // 第二种短标签仅为已有 DSH 提示词兼容；正式协议仍使用 app_call。
  const match = tail.match(/^<app_call\s+name=["']recall_system_memory["']\s*>([\s\S]*)<\/app_call>$/)
    || tail.match(/^<recall_system_memory\s*>([\s\S]*)<\/recall_system_memory>$/);
  if (!match) throw new Error('记忆请求阶段或 app_call 格式不正确');
  const recall = JSON.parse(match[1]);
  if (!recall || Array.isArray(recall) || typeof recall !== 'object') throw new Error('recall 参数必须是 JSON 对象');
  if (!Object.keys(recall).length) throw new Error('recall 不能为空');
  return { document, recall };
}

function fields(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆条目必须是对象');
  const allowed = new Set([...FIELDS[kind], ...(['person','item'].includes(kind) ? ['id'] : [])]);
  for (const [key, text] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error('模型返回了不属于该表的字段：' + key);
    if (typeof text !== 'string' || (key !== 'tag' && !text.trim())) throw new Error('记忆字段必须是非空字符串');
  }
}

export function validateInitial(document, snapshot = []) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('四表输出必须是 JSON 对象');
  if (Object.keys(document).some(key => !['summary','people','items','agreements'].includes(key))) throw new Error('四表输出包含未知表');
  if (document.summary) { fields(document.summary, 'summary'); if (!document.summary.content?.trim()) throw new Error('概要正文不能为空'); }
  for (const key of ['people','items','agreements']) if (!Array.isArray(document[key])) throw new Error('四表输出缺少数组：' + key);
  const seen = new Set();
  for (const [key, kind] of Object.entries(GROUPS)) for (const value of document[key]) {
    fields(value, kind);
    if (!value.name?.trim()) throw new Error('人物／物品名称不能为空');
    const old = snapshot.find(row => row.id === value.id);
    if (value.id && (!old || old.kind !== kind || old.name !== value.name || old.mode !== 'hot')) throw new Error('初次整理只能用一致的 id/name 更新已有热记录');
    if (!value.id && snapshot.some(row => row.kind === kind && row.name === value.name.trim())) throw new Error('已有实体必须引用 id/name；冷记录应通过 recall 查询');
    const identity = value.id || kind + ':' + value.name.trim();
    if (seen.has(identity)) throw new Error('同一批次重复人物／物品');
    seen.add(identity);
  }
  for (const value of document.agreements) { fields(value, 'agreement'); if (!value.content?.trim()) throw new Error('约定正文不能为空'); }
  return document;
}

export function validateRecall(document, snapshot = []) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('recall 参数必须是 JSON 对象');
  if (Object.keys(document).some(key => !Object.hasOwn(GROUPS, key))) throw new Error('recall 只能查询人物和物品');
  const seen = new Set();
  for (const [key, kind] of Object.entries(GROUPS)) {
    const values = document[key] === undefined ? [] : document[key];
    if (!Array.isArray(values) || values.length > 100) throw new Error('recall 参数必须是最多100条的数组');
    for (const value of values) {
      if (!value || Object.keys(value).sort().join(',') !== 'id,name') throw new Error('recall 必须仅提供 id/name');
      const old = snapshot.find(row => row.id === value.id);
      if (!old || old.kind !== kind || old.name !== value.name || old.mode !== 'cold') throw new Error('recall 的表、id/name 或冷状态不匹配');
      if (seen.has(value.id)) throw new Error('recall 重复查询同一记录');
      seen.add(value.id);
    }
  }
  if (Object.keys(document).length && !seen.size) throw new Error('recall 不能为空');
  return document;
}

export function parseOptimized(raw, targets = []) {
  const match = String(raw ?? '').trim().match(/^<app_call\s+name="(optimize_system_memory|unchanged)"\s*>([\s\S]*?)<\/app_call>$/);
  if (!match) throw new Error('第二阶段必须仅返回 optimize_system_memory 或 unchanged 调用');
  if (match[1] === 'unchanged') {
    if (match[2].trim() !== '无新增') throw new Error('unchanged 必须是固定文本“无新增”');
    return { people: [], items: [] };
  }
  return validateOptimized(JSON.parse(match[2]), targets);
}

export function validateOptimized(document, targets = []) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Object.keys(document).length || Object.keys(document).some(key => !Object.hasOwn(GROUPS, key))) throw new Error('optimize 只能返回人物／物品更新');
  const selected = new Map(targets.map(row => [row.id, row]));
  const seen = new Set();
  const result = { people: [], items: [] };
  for (const [key, kind] of Object.entries(GROUPS)) {
    const values = document[key] === undefined ? [] : document[key];
    if (!Array.isArray(values)) throw new Error('optimize 参数必须是条目数组');
    for (const value of values) {
      fields(value, kind);
      const old = selected.get(value.id);
      if (!old || old.kind !== kind || old.mode !== 'cold' || old.name !== value.name || seen.has(value.id)) throw new Error('optimize 返回未查询、重复、跨表、改名或非冷条目');
      if (!Object.keys(value).some(field => field !== 'id' && field !== 'name')) throw new Error('optimize 必须提供变化字段');
      seen.add(value.id);
      result[key].push(value);
    }
  }
  if (!seen.size) throw new Error('无修改应返回 unchanged，不能返回空 optimize');
  return result;
}

export function snapshotState(snapshot) {
  const ignored = new Set(['vector', 'vector_signature', 'vectorized', 'hasVector']);
  return snapshot.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.has(key)).sort(([left], [right]) => left.localeCompare(right))));
}
