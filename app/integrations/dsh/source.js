import { readChatLog } from '../../memory/common/chat_log.js';
/** 从 DSH 会话读取用户与助手的对话文本，作为系统总结的输入源。 */

import { isHumanMessage } from '../../prompting/history/index.js';

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text') return block.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function messageText(event) {
  const data = event.data || {};
  const msg = data.message || data;
  const role = msg.role || (event.type === 'user/message' ? 'user' : 'assistant');
  const text = blockText(msg.content);
  return { role, text };
}

/**
 * 取一个会话的「原始事件」而不是压缩后的表面。
 * DSH 的上下文压缩只是往日志里追加一条 checkpoint，把被压的那段标记成 shadow，
 * 原始消息事件仍然完整留在 jsonl 里。read() 给的就是完整日志，readSurface() 给的是折叠后的表面。
 */
async function sessionEvents(sq, sessionId) {
  if (typeof sq.readSession === 'function') {
    try {
      const raw = await sq.readSession(sessionId);
      if (Array.isArray(raw?.events) && raw.events.length) return raw.events;
    } catch {
      /* 读不到原始日志就退回表面，至少不中断整轮总结 */
    }
  }
  const surface = await sq.readSurface(sessionId);
  return surface?.events || [];
}

/** 压缩时追加的摘要 checkpoint 不是真人说的话，总结时不能当消息读。 */
function isCompactionCheckpoint(event) {
  const source = event?.data?.message?.source ?? event?.data?.source;
  return source?.kind === 'compact-checkpoint';
}

export async function readDshMessages(ctx, { sessionIds = [], start, end, character }) {
  if (character) return readChatLog(start, end, character).filter(row => !sessionIds.length || sessionIds.includes(row.sessionId));
  const sq = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery;
  if (!sq) throw new Error('DSH 会话查询服务（sessionQuery）不可用');
  const list = await sq.listSessions();
  const wanted = new Set(sessionIds);
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  const selected = list.filter((s) => {
    const h = s.header || {};
    if (!h.id) return false;
    if (Number(h.delegationDepth) > 0) return false;
    if (h.parentSession) return false;
    if (wanted.size) return wanted.has(h.id);
    return true;
  });
  const out = [];
  for (const s of selected) {
    let events;
    try { events = await sessionEvents(sq, s.header.id); } catch { continue; }
    for (const event of events) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
      if (isCompactionCheckpoint(event)) continue;
      if (event.type === 'user/message' && !isHumanMessage({ ...(event.data?.message ?? event.data), role: 'user' })) continue;
      const time = typeof event.time === 'number' ? event.time : Date.parse(event.time);
      if (!Number.isFinite(time) || time < from || time >= to) continue;
      const { role, text } = messageText(event);
      const content = text.trim();
      if (!content) continue;
      out.push({
        id: s.header.id + ':' + event.seq,
        role,
        time: new Date(time).toISOString(),
        content,
        sessionId: s.header.id,
      });
    }
  }
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}
