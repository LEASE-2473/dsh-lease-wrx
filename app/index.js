import { bindSession, getRole, listRoles, saveRole, resolveRole, sessionPreset } from './common/roles.js';
import { withRole, currentRole } from './common/role-context.js';
import { registerMemoryScheduler } from './memory/scheduler.js';
import { readDefaultPromptSet } from './memory/common/prompt_files.js';
import { handleSystemMemory } from './memory/system_memory/routes.js';
import { handleSummary } from './memory/system_memory/summary-routes.js';
import { handleDiaries } from './memory/diaries/routes.js';
import { handleAiNotes } from './memory/ai_notes/routes.js';
import { handleUser } from './profile/user/routes.js';
import { handleAssistant } from './profile/assistant/routes.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR, applyConfigPatch, loadConfig, publicConfig } from './common/config.js';
import { batches, characterDoc, characters, beginColdActivities, beginColdDiaries, closeDb, finishColdActivities, finishColdDiaries, counts, insertChatLog, openDb, readSelf, readUser } from './memory/db.js';
import { readSharedChatWindow } from './memory/common/chat_log.js';
import { normalizeHistoryWindow } from './prompting/history/window.js';
import { isHumanMessage, isTurnInput, messageTime } from './prompting/history/index.js';
import { listProviders } from './providers/llm.js';
import { backfillVectors, recallBlock, recallStats } from './memory/recall.js';
import { loadPresets } from './preset/service.js';
import { compatApply, compatStatus } from './integrations/dsh/compat.js';
import { applyDraft, auditTail, discardDraft, draftSkill, grantSkill, readDraft, skillsState } from './skills/service.js';

import { readDshMessages } from './integrations/dsh/source.js';
import { memoryPromptSources, tavernDataText, tavernText } from './prompting/tavern.js';
import { checkUrl, fetchModels, testEmbedding, testRerank } from './providers/vectorapi.js';
import { registerTools } from './integrations/dsh/tools.js';

import { createRequestCapture } from './integrations/dsh/capture.js';
import { registerRequestHook } from './integrations/dsh/request-hook.js';
import { createPresetApi, servePresetUi } from './integrations/dsh/preset-api.js';
import { presetStore } from './preset/store.js';
import { createMemorySources } from './prompting/sources/memory.js';
import { profilePromptSources } from './preset/service.js';

export const name = 'dsh-wrx-memory';
export const inject = ['webServer'];

const PREFIX = '/plugins/dsh-wrx-memory';
const API_PREFIX = PREFIX + '/api';
const UI_PREFIX = PREFIX + '/ui';

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function eventText(event) {
  const message = event?.data?.message || event?.data || {};
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'tool-call') return '[tool-call ' + (block.name || block.id || '') + ']';
    if (block?.type === 'tool-result') return '[tool-result]';
    return '';
  }).filter(Boolean).join('\n');
}

export function apply(ctx) {
  const capture = createRequestCapture();
  ctx.on('llm/stream', (options, next) => { capture.record(options); return next(); });
  const profileSources = (input = {}) => {
    const cfg = loadConfig();
    const character = cfg.dshCharacters?.[0] || 'dsh';
    const doc = characterDoc(character);
    const user = readUser();
    const self = readSelf();
    const window = normalizeHistoryWindow(input.historyWindow ?? cfg.prompting?.historyWindow, cfg.prompting?.historyTurns ?? 30);
    const current = input.messages?.findLast(isTurnInput);
    const now = messageTime(current, input.messageTimes) ?? Date.now();
    const shared = input.sessionId && window.mode !== 'turns'
      ? readSharedChatWindow({ sessionId: input.sessionId, ...window, now })
      : { rows: [], startTime: window.mode === 'since' ? window.since : new Date(now - window.durationMinutes * 60000).toISOString(), endTime: new Date(now).toISOString() };
    const humanMessages = input.messages?.filter(isHumanMessage) ?? [];
    const memories = {
      ...memoryPromptSources(character, extractText(current), extractText(humanMessages.at(-2))),
      current_time: new Intl.DateTimeFormat('zh-CN', { timeZone: cfg.timezone || 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(now),
      current_date: new Intl.DateTimeFormat('zh-CN', { timeZone: cfg.timezone || 'Asia/Shanghai', dateStyle: 'medium' }).format(now),
    };
    return { ...memories, ...profilePromptSources(doc, user, self), char: doc.name || '当前角色', user: user.name || '用户', _historyWindow: { ...window, startTime: Date.parse(shared.startTime), endTime: Date.parse(shared.endTime) }, _sharedHistory: shared.rows };
  };
  let requestHook;
  ctx.effect(() => {
    requestHook = registerRequestHook({ resolveContext: input => resolveRole(input.agentPreset), loadState: () => presetStore.loadForRole(), loadConfig, loadSources: profileSources });
    return () => requestHook.dispose();
  }, 'lease-wrx: request composition');
  const handlePreset = createPresetApi({ sources: input => ({ ...requestHook?.previewSources(), ...profileSources(input) }), loadConfig, getSourceCatalog: () => requestHook?.status().sources ?? [] });
  let injectedTable = null;
  try {
    ctx.on?.('webserver/index-inject', (table) => { injectedTable = table; });
  } catch { /* noop */ }

  try {
    openDb();
    ctx.logger?.info?.('[wrx-memory] 记忆库已连接：' + loadConfig().dbPath);
  } catch (error) {
    ctx.logger?.warn?.('[wrx-memory] 打开记忆库失败：' + (error?.message || error));
  }

  // 给聊天模型用的记忆工具：查记忆、写日记、读日记、提交画像候选、改自己人设字段。
  // 放在 apply 里全局注册；tavern 预设的模型只有这几个入口，别的写库一律走管线或人工。
  try {
    const toolDisposers = registerTools(ctx);
    ctx.logger?.info?.('[wrx-memory] 已注册 ' + toolDisposers.length + ' 个记忆工具');
  } catch (error) {
    ctx.logger?.warn?.('[wrx-memory] 注册记忆工具失败：' + (error?.message || error));
  }

  // 上次进程中断留下的 running 批次标记为 error，便于重跑。
  try {
    openDb().prepare("UPDATE system_memory_batches SET status='error',error='应用重启中断' WHERE status='running'").run();
  } catch { /* noop */ }

  const running = new Set();
  const clientPings = [];

  // 酒馆注入：每轮重新编译的 system 段，不进历史消息。
  // 用最新一条用户输入做关键词触发的用户画像；tool 轮没有新的用户消息，内容不变，DSH 不会重复插入。
  const tavernSessions = new Map();
  const tavernLog = [];
  let tavernRegistered = false;
  const extractText = (message) => typeof message?.content === 'string' ? message.content : (message?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');

  // 启用角色的真人/助手正文保存到 chat_log，通过 session_id 关联已有会话的角色。
  // Default 与关闭角色不采集；工具调用、结果、思考和定时输入不进入正文流水。
  const loggedEvents = new Set();
  ctx.on('session/event', (session, event) => {
    try {
      const sid = session?.id || session?.header?.id;
      if (!sid) return;
      if (session?.header?.parentSession) return;
      const roleContext = bindSession(session, ctx);
      if (!roleContext.enabled) return;
      const type = event?.type;
      if (type !== 'user/message' && type !== 'assistant/message') return;
      const message = event.data?.message || event.data || {};
      if (type === 'user/message' && !isTurnInput({ ...message, role: 'user' })) return;
      if (type === 'user/message' && !isHumanMessage({ ...message, role: 'user' })) return;
      const key = String(sid) + ':' + String(event.seq);
      if (loggedEvents.has(key)) return;
      loggedEvents.add(key);
      if (loggedEvents.size > 4000) loggedEvents.clear();
      const text = extractText(message);
      if (!text.trim()) return;
      const eventTime = typeof event.time === 'number' ? event.time : Date.parse(event.time);
      const at = new Date(Number.isFinite(eventTime) ? eventTime : Date.now()).toISOString();
      const role = type === 'user/message' ? 'user' : 'assistant';
      insertChatLog(sid, role, at, text, roleContext.id, sessionPreset(session, ctx));
    } catch {
      /* 落库失败不能影响聊天 */
    }
  });

  const registerTavern = (scoped) => {
    try {
      const sp = scoped.get?.('systemPrompt') ?? scoped.systemPrompt;
      if (!sp?.section) return;
      if (sp.variable) scoped.effect(() => sp.variable('lease_wrx_role', (context = {}) => {
        const agent = context.agent;
        if (!agent?.session?.id) return '';
        const role = bindSession(agent.session, ctx);
        syncToolScope(agent, role);
        return role.id;
      }), 'lease-wrx: role routing before tool providers');
      scoped.on('agent/inbox/claimed', ({ agent, message } = {}) => {
        try {
          if (!isTurnInput(message)) return;
          const sid = agent?.session?.id;
          if (!sid) return;
          if (agent?.session?.header?.parentSession) return;
          const role = bindSession(agent.session, ctx);
          if (!role.enabled) { tavernSessions.delete(sid); return; }
          const previous = tavernSessions.get(sid);
          if (previous?.roleId === role.id && previous?.id === message.id && message.id != null) return;
          tavernSessions.set(sid, { roleId: role.id, id: message.id ?? Symbol('turn-input'), current: extractText(message), previous: previous?.roleId === role.id ? previous.current : '' });
        } catch { /* noop */ }
      }, { global: true });
      // 不注册空的 WRX 提示词段，原生角色的提示词渲染保持宿主自身输出。
      tavernRegistered = false;
    } catch {
      /* systemPrompt 不可用时静默 */
    }
  };
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], (scoped) => registerTavern(scoped));
    } catch {
      registerTavern(ctx);
    }
  } else {
    registerTavern(ctx);
  }

  const toolMasks = new Map();
  const syncToolScope = (agent, role) => {
    const previous = toolMasks.get(agent);
    previous?.(); toolMasks.delete(agent);
    if (role.enabled && !agent.session.header?.parentSession) return;
    const tools = agent.ctx?.get?.('tools') ?? agent.ctx?.tools;
    if (tools?.restrict && tools?.schemas) {
      const names = tools.schemas(agent).filter(tool => tool.name.startsWith('wrx_')).map(tool => tool.name);
      if (names.length) toolMasks.set(agent, tools.restrict({ deny: names }));
    }
  };
  ctx.effect(() => () => { for (const dispose of toolMasks.values()) dispose?.(); toolMasks.clear(); }, 'lease-wrx: role tool masks');
  const recallLog = [];
  const memorySources = createMemorySources({ loadConfig, recallBlock, tavernDataText });
  ctx.effect(() => () => memorySources.clear(), 'lease-wrx: memory source snapshots');
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context?.agent;
    const role = agent?.session?.id ? bindSession(agent.session, ctx) : null;
    if (role && !(context?.agent?.ctx?.get?.('systemPrompt') ?? context?.agent?.ctx?.systemPrompt)?.variable) syncToolScope(agent, role);
    const result = await next();
    if (!agent?.session?.id || agent.session.header?.parentSession || !role?.enabled) {
      if (result.tools) result.tools = result.tools.filter(tool => !tool.name.startsWith('wrx_'));
      return result;
    }
    try {
      const sections = await withRole(role, () => memorySources.read(agent.session.id, tavernSessions.get(agent.session.id)));
      result.sections = [...result.sections.filter(section => !['wrx:data', 'wrx:cross', 'wrx:recall'].includes(section.name)), ...sections];
    } catch (error) {
      ctx.logger?.warn?.('[lease-wrx] 记忆素材准备失败：' + error.message);
    }
    return result;
  }, { prepend: true });

  /** 管理页：只占 /ui，不能抢 /plugins/<id>/client.js。 */
  const serveUi = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const isUi = path === UI_PREFIX || path === UI_PREFIX + '/' || path === UI_PREFIX + '/index.html'
      || path === '/app/wrxmemory' || path === '/app/wrxmemory/' || path === '/app/wrxmemory/index.html';
    if (req.method === 'GET' && isUi) {
      try {
        const html = readFileSync(join(PLUGIN_DIR, 'app', 'static', 'settings', 'index.html'), 'utf8');
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(html);
        return;
      } catch (error) {
        return json(res, 500, { ok: false, error: '读取管理页失败：' + error.message });
      }
    }
    return json(res, 404, { ok: false, error: 'not found' });
  };

  const requestBodies = new WeakMap();
  const handleApi = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : '/';
    const query = url.searchParams;

    const selectedRole = query.get('character');
    if (selectedRole && currentRole()?.id !== selectedRole) {
      try { return await withRole(getRole(selectedRole), () => handleApi(req, res)); }
      catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (currentRole()?.id === 'default' && path.startsWith('/preset/')) return json(res, 400, { ok: false, error: 'Default角色不启用该功能' });
    // 子路由先读取自己的请求体，不能被旧管理 API 提前消费流。
    if (path.startsWith('/preset/')) {
      if (await handlePreset(req, res, path.slice('/preset'.length))) return;
      return json(res, 404, { error: '预设接口不存在' });
    }
    if (path === '/prompting/capture') {
      if (req.method === 'GET') return json(res, 200, capture.status());
      if (req.method === 'POST') {
        try {
          const value = JSON.parse(await readBody(req));
          if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled必须为布尔值');
          if (value.enabled !== undefined) capture.configure(value.enabled);
          if (value.clear === true) capture.clear();
          return json(res, 200, capture.status());
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
      return json(res, 405, { error: '不支持的方法' });
    }
    if (req.method === 'GET' && path === '/prompting/status') return json(res, 200, requestHook.status());
    if (currentRole()?.id === 'default' && (path.startsWith('/preset/') || path === '/prompting/config')) return json(res, 400, { ok: false, error: 'Default角色不启用该功能' });
    if (req.method === 'GET' && path === '/prompting/config') return json(res, 200, loadConfig().prompting ?? { enabled: false, historyTurns: 30 });

    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, service: name });

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const raw = requestBodies.get(req) ?? await readBody(req);
      requestBodies.set(req, raw);
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    }

    const api = path;
    const character = currentRole()?.id || loadConfig().dshCharacters[0];

    try {
      if (body.character && query.get('character') && body.character !== query.get('character')) throw new Error('正文与查询参数的角色不一致');
      const requestedCharacter = body.character || query.get('character');
      if (requestedCharacter && requestedCharacter !== character) return await withRole(getRole(requestedCharacter), () => handleApi(req, res));
      if (api === '/roles' && req.method === 'GET') return json(res, 200, { ok: true, roles: listRoles() });
      if (api === '/roles' && req.method === 'POST') {
        if (body.wrxPresetId && !presetStore.load().presets.some(preset => preset.id === body.wrxPresetId)) throw new Error('WRX预设不存在');
        return json(res, 200, { ok: true, role: saveRole({ id: body.id, create: body.update !== true, name: body.name, enabled: body.enabled, presetIds: body.presetIds, wrxPresetId: body.wrxPresetId }) });
      }
      if (api === '/agent-presets' && req.method === 'GET') {
        const registry = ctx.get?.('agentPresets') ?? ctx.agentPresets;
        return json(res, 200, { ok: true, presets: registry?.list ? await registry.list() : [], available: Boolean(registry?.list) });
      }
      if (character === 'default' && !['/state', '/roles', '/agent-presets', '/config'].includes(api)) return json(res, 400, { ok: false, error: 'Default角色不启用该功能' });
      const input = { req, res, api, body, query, character, ctx, running };
      if (api === '/memory' || api.startsWith('/memory/')) return handleSystemMemory(input);
      if (['/messages/count', '/batches', '/summarize'].includes(api)) return handleSummary(input);
      if (api === '/diary' || api.startsWith('/diary/')) return handleDiaries(input);
      if (api === '/activity' || api.startsWith('/activity/')) return handleAiNotes(input);
      if (api === '/user') return handleUser(input);
      if (api === '/self' || api === '/character') return handleAssistant(input);
      if (req.method === 'PUT' && api === '/prompting/config') {
        if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.historyTurns) || body.historyTurns < 0 || body.historyTurns > 10000) return json(res, 400, { error: 'enabled 必须是布尔值，historyTurns 必须为 0–10000 的整数' });
        if (body.baseConfig && JSON.stringify(body.baseConfig) !== JSON.stringify(withRole(getRole(character), () => loadConfig().prompting))) throw new Error('角色编排设置已变化，请重新读取');
        const historyWindow = normalizeHistoryWindow(body.historyWindow, body.historyTurns);
        const presentation = {};
        if (body.excludeModelSelection !== undefined) {
          if (typeof body.excludeModelSelection !== 'boolean') return json(res, 400, { error: 'excludeModelSelection 必须是布尔值' });
          presentation.excludeModelSelection = body.excludeModelSelection;
        }
        if (body.timestamps !== undefined) {
          if (!body.timestamps || typeof body.timestamps.enabled !== 'boolean' || (body.timestamps.timeZone !== undefined && typeof body.timestamps.timeZone !== 'string')) return json(res, 400, { error: 'timestamps 需要布尔 enabled 和有效时区 timeZone' });
          const timeZone = body.timestamps.timeZone?.trim() || 'Asia/Shanghai';
          try { new Intl.DateTimeFormat('zh-CN', { timeZone }); } catch { return json(res, 400, { error: 'timeZone 必须是有效的 IANA 时区' }); }
          presentation.timestamps = { enabled: body.timestamps.enabled, timeZone };
        }
        if (body.midConversationSystem !== undefined) {
          if (!['preserve', 'user'].includes(body.midConversationSystem)) return json(res, 400, { error: 'midConversationSystem 必须为 preserve 或 user' });
          presentation.midConversationSystem = body.midConversationSystem;
        }
        const config = applyConfigPatch({ prompting: { enabled: body.enabled, historyTurns: body.historyTurns, historyWindow, ...presentation } });
        return json(res, 200, config.prompting);
      }
      if (req.method === 'GET' && api === '/state') {
        const cfg = publicConfig();
        const chars = characters().map((c) => ({ ...c, counts: counts(c.id) }));
        return json(res, 200, {
          ok: true,
          config: cfg,
          roles: listRoles(),
          characters: chars,
          batches: batches(character, 20),
          summaryEnabled: cfg.summary.enabled,
          vectorEnabled: cfg.vector.enabled,
        });
      }
      if (req.method === 'GET' && api === '/recall/state') {
        const target = character || (loadConfig().dshCharacters?.[0] || 'dsh');
        return json(res, 200, {
          ok: true,
          character: target,
          ...recallStats(target),
          enabled: loadConfig().vector.enabled,
          recent: recallLog.slice(-5),
        });
      }
      if (req.method === 'POST' && api === '/vector/backfill') {
        const target = character || (loadConfig().dshCharacters?.[0] || 'dsh');
        const result = await backfillVectors(target, { limit: Number(body.limit) || 400 });
        return json(res, 200, { ok: true, character: target, ...result, ...recallStats(target) });
      }
      if (req.method === 'GET' && api === '/recall/preview') {
        const target = character || (loadConfig().dshCharacters?.[0] || 'dsh');
        const started = Date.now();
        const out = await recallBlock(target, query.get('q') || '');
        return json(res, 200, {
          ok: true,
          character: target,
          ms: Date.now() - started,
          ...recallStats(target),
          text: out.text,
          hits: out.hits,
        });
      }
      if (req.method === 'GET' && api === '/cold/stats') {
        const cfg = loadConfig();
        const cid = character || cfg.dshCharacters?.[0] || 'dsh';
        const d = openDb();
        const count = (sql) => d.prepare(sql).get(cid)?.c || 0;
        return json(res, 200, {
          ok: true,
          stat: {
            // 四态：热 = 未向量化走注入；转冷中 = 正在向量化；冷 = 已向量化走召回；
            // 冻结 = 不注入不召回，只能靠工具自己查（日记太长，召回的性价比太低）。
            diariesHot: count("SELECT COUNT(*) c FROM diaries WHERE character_id=? AND injection_mode='hot'"),
            diariesPending: count("SELECT COUNT(*) c FROM diaries WHERE character_id=? AND injection_mode='pending'"),
            diariesCold: count("SELECT COUNT(*) c FROM diaries WHERE character_id=? AND injection_mode='cold'"),
            diariesFreeze: count("SELECT COUNT(*) c FROM diaries WHERE character_id=? AND injection_mode='freeze'"),
            diariesColdMissingVector: count("SELECT COUNT(*) c FROM diaries WHERE character_id=? AND injection_mode='cold' AND vector IS NULL"),
            activitiesHot: count("SELECT COUNT(*) c FROM ai_notes WHERE character_id=? AND injection_mode='hot'"),
            activitiesPending: count("SELECT COUNT(*) c FROM ai_notes WHERE character_id=? AND injection_mode='pending'"),
            activitiesCold: count("SELECT COUNT(*) c FROM ai_notes WHERE character_id=? AND injection_mode='cold'"),
            activitiesFreeze: count("SELECT COUNT(*) c FROM ai_notes WHERE character_id=? AND injection_mode='freeze'"),
            activitiesColdMissingVector: count("SELECT COUNT(*) c FROM ai_notes WHERE character_id=? AND injection_mode='cold' AND vector IS NULL"),
            diaryDays: Number(cfg.tavern?.diaryDays) || 2,
            activityDays: Number(cfg.tavern?.activityDays) || 2,
          },
        });
      }
      if (req.method === 'POST' && api === '/cold/rotate') {
        const cfg = loadConfig();
        const cid = character || cfg.dshCharacters?.[0] || 'dsh';
        // 冷 = 已向量化；没有向量能力就转不了。
        if (!cfg.vector?.enabled) return json(res, 400, { ok: false, error: '向量记忆未启用：冷 = 已向量化，没向量能力转不了' });
        const diaryTarget = cfg.tavern?.diaryColdTo === 'cold' ? 'cold' : 'freeze';
        const activityTarget = cfg.tavern?.activityColdTo === 'freeze' ? 'freeze' : 'cold';
        const beganD = beginColdDiaries(cid, Number(cfg.tavern?.diaryDays) || 2, diaryTarget);
        const beganA = beginColdActivities(cid, Number(cfg.tavern?.activityDays) || 2, activityTarget);
        const frozen = beganD.frozen + beganA.frozen;
        let vec = null;
        try {
          vec = await backfillVectors(cid);
        } catch (error) {
          ctx.logger?.warn?.('[wrx-memory] 手动转冷时向量化失败，下一轮心跳继续：' + (error?.message || error));
        }
        const coldD = finishColdDiaries(cid);
        const coldA = finishColdActivities(cid);
        const d = openDb();
        const pending = (d.prepare("SELECT COUNT(*) c FROM diaries WHERE character_id=? AND injection_mode='pending'").get(cid)?.c || 0)
          + (d.prepare("SELECT COUNT(*) c FROM ai_notes WHERE character_id=? AND injection_mode='pending'").get(cid)?.c || 0);
        ctx.logger?.info?.('[wrx-memory] 手动转冷：转冷完成 ' + (coldD + coldA) + ' 条、冻结 ' + frozen + ' 条，新补向量 ' + (vec?.done || 0) + ' 条，还剩转冷中 ' + pending + ' 条');
        return json(res, 200, { ok: true, cold: coldD + coldA, frozen, vectorized: vec?.done || 0, pending });
      }
      if (req.method === 'GET' && api === '/config') {
        return json(res, 200, { ok: true, config: publicConfig() });
      }
      if (req.method === 'POST' && api === '/config') {
        if (character === 'default') throw new Error('Default角色不启用该功能');
        const next = applyConfigPatch(body.patch || body);
        closeDb();
        return json(res, 200, { ok: true, config: publicConfig(), saved: Boolean(next) });
      }
      if (req.method === 'GET' && api === '/prompts') {
        return json(res, 200, { ok: true, prompts: loadConfig().prompts });
      }
      if (req.method === 'GET' && api === '/prompts/defaults') {
        return json(res, 200, { ok: true, prompts: readDefaultPromptSet() });
      }
      if (req.method === 'POST' && api === '/prompts/reset') {
        const next = applyConfigPatch({ prompts: readDefaultPromptSet() });
        return json(res, 200, { ok: true, prompts: next.prompts });
      }
      if (req.method === 'POST' && api === '/prompts') {
        const next = applyConfigPatch({ prompts: body.prompts || {} });
        return json(res, 200, { ok: true, prompts: next.prompts });
      }
      if (req.method === 'GET' && api === '/llm/providers') {
        const providers = await listProviders(ctx);
        return json(res, 200, { ok: true, providers, defaultSelection: ctx.get?.('agentDefaultModel')?.currentSelection?.() || null });
      }
      if (req.method === 'POST' && api === '/llm/test') {
        const { complete } = await import('./providers/llm.js');
        const text = await complete(ctx, loadConfig(), {
          system: '你是一个连通性测试助手，只回复两个字：收到',
          messages: [{ role: 'user', text: '测试' }],
          maxTokens: 32,
        });
        return json(res, 200, { ok: true, text: String(text).slice(0, 200) });
      }
      if (req.method === 'POST' && api === '/vector/check') {
        const kind = body.kind === 'rerank' ? 'rerank' : 'embedding';
        return json(res, 200, { ok: true, ...checkUrl(body.url, kind) });
      }
      if (req.method === 'POST' && api === '/vector/models') {
        const kind = body.kind === 'rerank' ? 'rerank' : 'embedding';
        const cfg = loadConfig().vector;
        const url = kind === 'rerank' ? (body.url || cfg.rerankUrl) : (body.url || cfg.apiUrl);
        const key = kind === 'rerank' ? (body.key ?? cfg.rerankKey) : (body.key ?? cfg.apiKey);
        return json(res, 200, { ok: true, kind, ...(await fetchModels(url, key)) });
      }
      if (req.method === 'POST' && api === '/vector/test') {
        const kind = body.kind === 'rerank' ? 'rerank' : 'embedding';
        const cfg = loadConfig().vector;
        const vector = kind === 'rerank'
          ? { rerankUrl: body.url || cfg.rerankUrl, rerankKey: body.key ?? cfg.rerankKey, rerankModel: body.model || cfg.rerankModel }
          : { apiUrl: body.url || cfg.apiUrl, apiKey: body.key ?? cfg.apiKey, model: body.model || cfg.model };
        const result = kind === 'rerank' ? await testRerank(vector) : await testEmbedding(vector);
        return json(res, 200, { ok: true, kind, ...result });
      }
      if (req.method === 'GET' && api === '/presets') {
        return json(res, 200, { ok: true, state: loadPresets() });
      }
      if (req.method === 'GET' && api === '/compat') {
        try {
          return json(res, 200, { ok: true, ...compatStatus() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message || error) });
        }
      }
      if (req.method === 'POST' && api === '/compat/apply') {
        try {
          return json(res, 200, compatApply(body.name || 'all'));
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message || error) });
        }
      }
      if (req.method === 'GET' && api === '/skills') {
        return json(res, 200, { ok: true, ...skillsState() });
      }
      if (req.method === 'POST' && api === '/skills/grant') {
        return json(res, 200, { ok: true, ...grantSkill(body.skill, body.mode, body.minutes) });
      }
      if (req.method === 'GET' && api === '/skills/draft') {
        return json(res, 200, { ok: true, draft: readDraft(query.get('id')) });
      }
      if (req.method === 'POST' && api === '/skills/draft') {
        const draft = await draftSkill(ctx, body.skill, { hours: body.hours, source: body.source || 'ui' });
        return json(res, 200, { ok: true, draft });
      }
      if (req.method === 'POST' && api === '/skills/apply') {
        return json(res, 200, { ok: true, ...applyDraft(body.id, { source: body.source || 'ui', confirmed: Boolean(body.confirmed) }) });
      }
      if (req.method === 'POST' && api === '/skills/discard') {
        return json(res, 200, { ok: true, ...discardDraft(body.id) });
      }
      if (req.method === 'GET' && api === '/skills/audit') {
        return json(res, 200, { ok: true, lines: auditTail(40) });
      }
      if (req.method === 'GET' && api === '/tavern/preview') {
        const cfg = loadConfig();
        const input = query.get('input') || '';
        return json(res, 200, {
          ok: true,
          registered: tavernRegistered,
          tavern: cfg.tavern || {},
          text: tavernText(character, input, '', { force: true }),
        });
      }
      if (req.method === 'GET' && api === '/debug/last-request') {
        const sq = ctx.get?.('sessionQuery');
        const sessions = sq ? await sq.listSessions() : [];
        const candidates = sessions.slice(0, 10);
        const listing = [];
        const eventsById = new Map();
        for (const s of candidates) {
          const id = s.header?.id || s.id;
          let events = [];
          try { events = (await sq.readSurface(id))?.events || []; } catch { /* noop */ }
          eventsById.set(id, events);
          const lastUser = [...events].reverse().find((e) => e.type === 'user/message');
          listing.push({
            id,
            title: s.header?.title || '',
            cwd: s.header?.cwd || '',
            createdAt: s.header?.createdAt || '',
            lastUser: lastUser?.time ? Number(lastUser.time) : 0,
          });
        }
        listing.sort((a, b) => b.lastUser - a.lastUser);
        const target = query.get('id') || listing[0]?.id || null;
        const events = eventsById.get(target) || [];
        const systems = events.filter((e) => e.type === 'system/message');
        const recent = events
          .filter((e) => ['user/message', 'assistant/message', 'tool/result'].includes(e.type))
          .slice(-12);
        return json(res, 200, {
          ok: true,
          session: target,
          sessions: listing.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, lastUser: s.lastUser, createdAt: s.createdAt })),
          injected: tavernLog.slice(-1)[0] || null,
          system: systems.slice(-1).map((e) => ({ seq: e.seq, chars: eventText(e).length, text: eventText(e) })),
          recent: recent.map((e) => ({ type: e.type, seq: e.seq, chars: eventText(e).length, text: eventText(e).slice(0, 1500) })),
        });
      }
      if (req.method === 'POST' && api === '/client-ping') {
        clientPings.push({ at: new Date().toISOString(), ...body });
        while (clientPings.length > 30) clientPings.shift();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && api === '/debug/ping') {
        return json(res, 200, { ok: true, pings: clientPings });
      }
      if (req.method === 'GET' && api === '/debug/inject') {
        if (!injectedTable) return json(res, 200, { ok: true, captured: false });
        const items = Array.from(injectedTable).map((x) => JSON.stringify(x).slice(0, 400));
        return json(res, 200, {
          ok: true,
          captured: true,
          count: items.length,
          hasWrx: items.some((x) => x.includes('dsh-wrx-memory')),
          items,
        });
      }
      if (req.method === 'GET' && api === '/debug/client') {
        const cm = ctx.get?.('clientModules');
        if (!cm) return json(res, 200, { ok: true, available: false });
        const graph = typeof cm.graph === 'function' ? cm.graph() : null;
        const text = JSON.stringify(graph);
        return json(res, 200, {
          ok: true,
          available: true,
          rev: graph?.rev || null,
          entryCount: Array.isArray(graph?.entries) ? graph.entries.length : null,
          entries: Array.isArray(graph?.entries)
            ? graph.entries.map((e) => ({ id: e?.id, url: e?.url, rev: e?.rev }))
            : null,
          batches: Array.isArray(graph?.batches)
            ? graph.batches.map((b) => ({ phase: b?.phase, url: b?.url, rev: b?.rev }))
            : null,
          preview: text ? text.slice(0, 3000) : null,
        });
      }
      if (req.method === 'GET' && api === '/debug/session') {
        const sq = ctx.get?.('sessionQuery');
        if (!sq) return json(res, 200, { ok: true, available: false });
        const sessions = await sq.listSessions();
        const target = query.get('id') || sessions[0]?.header?.id || sessions[0]?.id;
        const surface = target ? await sq.readSurface(target) : null;
        const events = surface?.events || [];
        const eventCounts = {};
        for (const e of events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
        // raw=1：对比「压缩后的表面」和「原始事件日志」，确认被 shadow 的原文还读得到。
        let raw = null;
        let rawError = null;
        if (target && query.get('raw') && typeof sq.readSession === 'function') {
          try { raw = await sq.readSession(target); } catch (e) { rawError = String(e?.message || e); }
        }
        const rawCounts = {};
        if (raw) for (const e of raw.events || []) rawCounts[e.type] = (rawCounts[e.type] || 0) + 1;
        let msgProbe = null;
        if (query.get('msg')) {
          const hours = Number(query.get('hours')) || 24;
          const end = Date.now();
          const start = end - hours * 3600000;
          try {
            const list = await readDshMessages(ctx, { start: new Date(start).toISOString(), end: new Date(end).toISOString() });
            const pick = (m) => ({ role: m.role, time: m.time, head: String(m.content || '').replace(/\s+/g, ' ').slice(0, 48) });
            msgProbe = { count: list.length, first: list.slice(0, 3).map(pick), last: list.slice(-2).map(pick) };
          } catch (e) {
            msgProbe = { error: String(e?.message || e) };
          }
        }
        return json(res, 200, {
          ok: true, available: true, sessions: sessions.slice(0, 12), target, eventCounts,
          ...(raw ? { rawEventCounts: rawCounts, rawTotal: (raw.events || []).length, surfaceTotal: events.length, shadowed: Math.max(0, (raw.events || []).length - events.length) } : {}),
          ...(rawError ? { rawError } : {}),
          ...(msgProbe ? { msgProbe } : {}),
        });
      }
      return json(res, 404, { ok: false, error: '未知接口：' + api });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message || error) });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi }), 'wrx-memory: http api');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: UI_PREFIX, handler: serveUi }), 'wrx-memory: http ui');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX + '/preset-ui', handler: servePresetUi }), 'lease-wrx: preset editor');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/app/wrxmemory', handler: serveUi }), 'wrx-memory: http app page');

  registerMemoryScheduler(ctx, { running });

  ctx.logger?.info?.('[wrx-memory] 管理页：' + UI_PREFIX);
}
