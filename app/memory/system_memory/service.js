
import { createHash } from 'node:crypto';
import { loadConfig } from '../../common/config.js';
import { readDshMessages } from '../../integrations/dsh/source.js';
import { complete } from '../../providers/llm.js';
import { applyMemoryBatch, batchFind, batchUpsert, existingPayload, latestProcessedEnd, memoryIndex, queriedRecords, listRows } from './repository.js';
import { parseInitial, parseOptimized, validateInitial, validateRecall } from './protocol.js';
import { characters } from '../../profile/assistant/information.js';
import { conversations, readMessages } from '../common/conversations.js';
import { listTempSummaries, markTempSummaries, saveTempSummary } from './temporary.js';
import { readChatLog, recordSummaryCoverage } from '../common/chat_log.js';
import { toIso } from '../common/utilities.js';

import { isContextOverflow, DEFAULT_MAX_INPUT_CHARS, MERGE_INSTRUCTION, plainMessages, splitMessage } from '../common/generation.js';

async function summarizePiece(ctx, cfg, { base, messages, character, start, end }) {
  const maxChars = Math.max(20000, Number(cfg.summary?.maxChars) || DEFAULT_MAX_INPUT_CHARS);
  const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  if (chars <= maxChars) {
    try {
      const raw = await complete(ctx, cfg, {
        system: cfg.prompts.system,
        messages: [{ role: 'user', text: JSON.stringify({ ...base, messages: plainMessages(messages) }) }],
        maxTokens: 0,
      });
      const tempId = saveTempSummary(character, 'seg', messages[0]?.time || start, messages[messages.length - 1]?.time || end, raw);
      return { raw, tempIds: [tempId], pieces: 1 };
    } catch (error) {
      if (!isContextOverflow(error)) throw error;
      // 报超限：落到下面继续拆，不往上抛。
    }
  }
  let leftMessages;
  let rightMessages;
  if (messages.length > 1) {
    const mid = Math.floor(messages.length / 2);
    leftMessages = messages.slice(0, mid);
    rightMessages = messages.slice(mid);
  } else {
    [leftMessages, rightMessages] = splitMessage(messages[0], maxChars);
  }
  const left = await summarizePiece(ctx, cfg, { base, messages: leftMessages, character, start, end });
  const right = await summarizePiece(ctx, cfg, { base, messages: rightMessages, character, start, end });
  const mergePayload = {
    ...base,
    messages: [
      { time: leftMessages[0]?.time || start, role: 'user', content: left.raw },
      { time: rightMessages[0]?.time || start, role: 'user', content: right.raw },
    ],
  };
  const raw = await complete(ctx, cfg, {
    system: cfg.prompts.system + MERGE_INSTRUCTION(),
    messages: [{ role: 'user', text: JSON.stringify(mergePayload) }],
    maxTokens: 0,
  });
  return { raw, tempIds: [...left.tempIds, ...right.tempIds], pieces: left.pieces + right.pieces };
}

/**
 * 第一段总结。装得下就一次；装不下按时间一拆二递归，最后合并成一份。
 */
async function stageOne(ctx, cfg, { base, messages, character, start, end }) {
  // 上一个窗口留下的临时尾段先并进来，总结成功后置 merged，避免被下一批重复消费。
  const carried = listTempSummaries(character, 'temp', 20)
    .filter((row) => !row.range_end || String(row.range_end) <= String(end))
    .map((row) => ({
      sessionId: 'temp:' + String(row.session_id || ''),
      time: row.range_end,
      role: 'user',
      content: '[上一窗口临时记录]\n' + row.content,
      tempSequence: row.sequence,
    }));
  const all = carried.length ? [...messages, ...carried] : messages;
  const carriedIds = carried.map((row) => row.tempSequence);
  const result = await summarizePiece(ctx, cfg, { base, messages: all, character, start, end });
  return { raw: result.raw, split: result.pieces - 1, carriedIds: [...carriedIds, ...result.tempIds] };
}

const activeBatches = new Map();

export async function runBatch(ctx, options) {
  const previous = activeBatches.get(options.character) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => runBatchUnlocked(ctx, options));
  activeBatches.set(options.character, pending);
  try {
    return await pending;
  } finally {
    if (activeBatches.get(options.character) === pending) activeBatches.delete(options.character);
  }
}

async function runBatchUnlocked(ctx, { character, start, end, debug = false, sessionIds = [] }) {
  const cfg = loadConfig();
  const char = characters().find((c) => c.id === character);
  if (!char) throw new Error('角色不存在：' + character);
  const isDsh = Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.includes(character);
  const conv = isDsh ? { id: 'dsh-session', timezone: cfg.timezone } : conversations(character)[0];
  if (!conv) throw new Error('角色没有会话');
  const from = toIso(start);
  const to = toIso(end);
  if (new Date(to) <= new Date(from)) throw new Error('结束时间必须晚于开始时间');

  // 批次 id 只认时间窗（拆分时再带上 sessionIds），不掺消息摘要：
  // 同一个 [from,to) 窗只跑一次，否则窗口里再落一条消息就换 id、整小时重跑一遍。
  // 先按 id 查批次再读日志，已经 done/empty 的窗口连原文都不用读。
  const batchId = createHash('sha256')
    .update([character, from, to, sessionIds.slice().sort().join(',')].join(':'))
    .digest('hex');
  const existingBatch = batchFind(batchId);
  if (existingBatch && (existingBatch.status === 'done' || existingBatch.status === 'empty')) {
    return { status: 'already_processed', batchId, messages: 0 };
  }

  let messages;
  if (isDsh) {
    // 优先用插件自己的跨会话流水；这段还没有（插件刚装/messages 表还空）再回退 DSH 原始日志。
    messages = readChatLog(from, to, character);
    if (sessionIds.length) messages = messages.filter(message => sessionIds.includes(message.sessionId));
    if (!messages.length) messages = await readDshMessages(ctx, { character, start: from, end: to, sessionIds });
  } else {
    messages = readMessages(character, from, to);
  }
  batchUpsert({
    id: batchId, character_id: character, conversation_id: conv.id,
    range_start: from, range_end: to, status: 'running', error: '',
  });

  try {
    if (messages.length === 0) {
      batchUpsert({ id: batchId, character_id: character, conversation_id: conv.id, range_start: from, range_end: to, status: 'empty' });
      return { status: 'empty', batchId, messages: 0 };
    }
    const user = cfg.user?.name || char.user_name || '用户';
    const snapshot = listRows(character);
    const existing = existingPayload(character, snapshot);
    const index = memoryIndex(character, snapshot);
    // stageOne 已递归拆分超长输入；不得先裁掉正文再把整段标为“已总结”。
    const trimmed = messages.map(message => ({ ...message, content: String(message.content || '') }));
    const base = {
      character: char.name,
      user_name: user,
      timezone: conv.timezone || cfg.timezone,
      existing,
      memory_index: index,
    };
    const stage1 = await stageOne(ctx, cfg, { base, messages: trimmed, character, start: from, end: to });
    const stage1Raw = stage1.raw;
    const parsedInitial = parseInitial(stage1Raw);
    const stage1Json = validateInitial(parsedInitial.document, snapshot);
    validateRecall(parsedInitial.recall, snapshot);

    const recall = parsedInitial.recall;
    let updates = { people: [], items: [] };
    let stage2Raw = null;
    if (recall && (recall.people?.length || recall.items?.length)) {
      const queried = queriedRecords(character, recall, snapshot);
      const payload2 = {
        character: char.name,
        user_name: user,
        timezone: conv.timezone || cfg.timezone,
        messages: trimmed.map((m) => ({ time: m.time, role: m.role, content: m.content })),
        queried_records: queried,
      };
      stage2Raw = await complete(ctx, cfg, {
        system: cfg.prompts.update,
        messages: [{ role: 'user', text: JSON.stringify(payload2) }],
        maxTokens: 0,
      });
      const targets = new Set(Object.values(recall).flat().map(value => value.id));
      updates = parseOptimized(stage2Raw, snapshot.filter(row => targets.has(row.id)));
    }

    const { applied, appliedUpdate } = applyMemoryBatch(character, conv.id, from, to, stage1Json, updates, {
      snapshot, recall,
      commit() {
        batchUpsert({ id: batchId, character_id: character, conversation_id: conv.id, range_start: from, range_end: to, status: 'done' });
        recordSummaryCoverage(batchId, messages);
        if (stage1.carriedIds.length) markTempSummaries(stage1.carriedIds, 'merged');
      },
    });
    return {
      status: 'done', batchId, messages: messages.length, applied, appliedUpdate,
      recalled: Boolean(recall),
      split: stage1.split || 0,
      ...(debug ? { stage1Raw, stage2Raw } : {}),
    };
  } catch (error) {
    // 兜底：上下文超限且这批混了多个会话 → 按会话拆开分别总结，记忆仍写同一角色。
    if (isDsh && isContextOverflow(error) && sessionIds.length === 0) {
      const bySession = new Map();
      for (const m of messages) {
        if (!m.sessionId) continue;
        if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, []);
        bySession.get(m.sessionId).push(m);
      }
      if (bySession.size > 1) {
        const results = [];
        for (const sid of bySession.keys()) {
          results.push(await runBatchUnlocked(ctx, { character, start, end, debug, sessionIds: [sid] }));
        }
        batchUpsert({
          id: batchId, character_id: character, conversation_id: conv.id,
          range_start: from, range_end: to, status: 'done',
        });
        return { status: 'split', batchId, messages: messages.length, sessions: bySession.size, results };
      }
    }
    batchUpsert({
      id: batchId, character_id: character, conversation_id: conv.id,
      range_start: from, range_end: to, status: 'error', error: String(error?.message || error).slice(0, 1000),
    });
    throw error;
  }
}

export async function summarizeRange(ctx, { character, start, end, debug = false, maxBatches = 200, auto = false }) {
  const cfg = loadConfig();
  const intervalMs = Math.max(1, Number(cfg.summary.intervalMinutes) || 60) * 60000;
  const latest = latestProcessedEnd(character);
  const defaultStart = auto ? Date.now() - intervalMs : (latest ? new Date(latest).getTime() : Date.now() - 86400000);
  const from = start ? new Date(start) : new Date(defaultStart);
  const to = end ? new Date(end) : new Date();
  const results = [];
  let cursor = from.getTime();
  let guard = 0;
  while (cursor < to.getTime() && guard < maxBatches) {
    const stop = Math.min(to.getTime(), cursor + intervalMs);
    const result = await runBatch(ctx, { character, start: new Date(cursor).toISOString(), end: new Date(stop).toISOString(), debug });
    results.push(result);
    cursor = stop;
    guard++;
    if (result.status === 'empty' || result.status === 'already_processed') continue;
    await new Promise((r) => setTimeout(r, Math.max(0, Number(cfg.summary.delaySeconds) || 0) * 1000));
  }
  return {
    batches: results.length,
    done: results.filter((r) => r.status === 'done').length,
    empty: results.filter((r) => r.status === 'empty').length,
    skipped: results.filter((r) => r.status === 'already_processed').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
}

/* ---------- 日记 ---------- */

