import { withRole, roleId } from '../../common/role-context.js';
/** 仅注册请求组装边界；安装宿主小补丁是独立显式操作，不在插件启动时改宿主。 */
import { createSnapshotCompiler } from '../../prompting/snapshots/index.js';
import { splitConversation } from '../../prompting/history/index.js';
import { presentRequest } from './request-presentation.js';
import { createHash } from 'node:crypto';
import { applyCompactionBoundary } from '../../prompting/history/compaction.js';

export const REQUEST_HOOK = Symbol.for('lease-wrx.request-transform.v1');
const texts = sections => sections.map(s => s.text ?? '').filter(Boolean).join('\n\n');
export function sectionSources(assembly) {
  const result = [];
  for (const category of ['sections', 'contexts']) {
    const counts = new Map();
    for (const section of assembly?.[category] ?? []) {
      if (section.name?.startsWith('wrx:')) continue;
      const label = section.name || 'unnamed';
      const occurrence = counts.get(label) ?? 0;
      counts.set(label, occurrence + 1);
      const key = createHash('sha256').update(JSON.stringify([category, label, occurrence])).digest('hex').slice(0, 24);
      result.push({ name: `dsh.${category}.${key}`, sectionName: label, category, label: `DSH ${category === 'contexts' ? '背景' : '提示词'}：${label}${occurrence ? ` (${occurrence + 1})` : ''}`, description: '宿主已渲染的独立内容；使用此条目时请关闭包含它的组合插槽以免重复', kind: 'text', text: section.text ?? '' });
    }
  }
  return result;
}
export function collectDshSources({ messages = [], assembly, tools = [], cwd }) {
  const sections = assembly?.sections ?? [];
  const native = sections.filter(s => !s.name?.startsWith('wrx:'));
  const tool = s => /tool|mcp|sdk/i.test(s.name ?? '');
  const skill = s => /skill/i.test(s.name ?? '');
  return {
    'dsh.cwd': typeof cwd === 'string' ? cwd : '',
    _dshSections: sectionSources(assembly).filter(source => source.category === 'sections'),
    ...Object.fromEntries(sectionSources(assembly).map(source => [source.name, source.text])),
    'dsh.preset': sections.length ? texts(native.filter(s => !tool(s) && !skill(s))) : messages.filter(m => m.role === 'system').map(m => texts(m.content ?? [])).join('\n\n'),
    'dsh.tool_instructions': texts(native.filter(s => tool(s) && !skill(s))),
    'dsh.skills': texts(native.filter(skill)),
    'dsh.tools': tools.map(t => `${t.name}: ${t.description ?? ''}`).join('\n'),
    'wrx.memory': texts(sections.filter(s => s.name === 'wrx:data')),
    'wrx.recall': texts(sections.filter(s => s.name === 'wrx:recall' || s.name === 'wrx:cross')),
  };
}
export function registerRequestHook({ loadState, loadConfig, loadSources = () => ({}), resolveContext }) {
  if (globalThis[REQUEST_HOOK]) throw new Error('LEASE WRX 请求接管已被另一个实例注册');
  let last = null;
  const roleViews = new Map();
  let observed = false;
  let sourceCatalog = [];
  let previewSources = {};
  const presentation = new Map();
  const compiler = createSnapshotCompiler({ loadState, loadSources: input => ({ ...collectDshSources(input), ...loadSources(input) }) });
  const transform = input => {
    if (!resolveContext) return compose(input);
    const role = resolveContext(input);
    if (!role?.enabled || input.parentSession) return input.messages;
    return withRole(role, () => compose({ ...input, roleKey: role.id + ':' + (input.agentPreset ?? '') }));
  };
  const compose = input => {
    observed = true;
    sourceCatalog = sectionSources(input.assembly);
    previewSources = structuredClone({ ...collectDshSources(input), 'dsh.runtime': splitConversation(input.messages).runtime });
    const viewKey = roleId() ?? 'global';
    roleViews.set(viewKey, { sourceCatalog, previewSources, last: null });
    const loaded = loadConfig();
    const config = loaded.prompting ?? {};
    if (!config.enabled || input.parentSession) return input.messages;
    const compaction = applyCompactionBoundary(input);
    input = { ...input, messages: compaction.messages, messageTimes: compaction.messageTimes, compactionKey: compaction.key };
    const key = splitConversation(input.messages, config.historyTurns ?? 30).key;
    let options = presentation.get(input.sessionId);
    if (!options || options.key !== key || options.roleKey !== input.roleKey) {
      options = { key, roleKey: input.roleKey, messageTimes: structuredClone(input.messageTimes ?? {}), options: structuredClone({ excludeModelSelection: config.excludeModelSelection === true, timestamps: config.timestamps ?? {}, midConversationSystem: config.midConversationSystem ?? 'preserve', timeZone: loaded.timezone || 'Asia/Shanghai' }) };
      presentation.delete(input.sessionId);
      presentation.set(input.sessionId, options);
      if (presentation.size > 100) presentation.delete(presentation.keys().next().value);
    }
    for (const message of compaction.messages) if (message.leaseWrxCompaction) options.messageTimes[message.id] = message.leaseWrxCompaction.endTime;
    const result = compiler.compile({ ...input, historyTurns: config.historyTurns ?? 30 });
    const parameters = result.generationParameters;
    const temperature = parameters?.temperature;
    if (input.generationOptions && parameters?.enabled === true && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) input.generationOptions.temperature = temperature;
    const rendered = presentRequest(result.messages, options.options, options.messageTimes);
    last = { sessionId: input.sessionId, trace: result.trace, warnings: [...compaction.warnings, ...result.warnings, ...rendered.warnings, ...(parameters?.enabled && !input.generationOptions ? ['宿主未提供生成参数接入，预设温度未传递'] : [])], generationOptions: { ...input.generationOptions }, messageCount: rendered.messages.length, midConversationSystem: options.options.midConversationSystem };
    roleViews.set(viewKey, { sourceCatalog, previewSources, last });
    return rendered.messages;
  };
  globalThis[REQUEST_HOOK] = transform;
  return {
    previewSources: () => structuredClone(roleViews.get(roleId() ?? 'global')?.previewSources ?? {}),
    status: () => ({ enabled: Boolean(loadConfig().prompting?.enabled), hookRegistered: globalThis[REQUEST_HOOK] === transform, hookObserved: observed, sources: structuredClone(roleViews.get(roleId() ?? 'global')?.sourceCatalog ?? []), scope: 'main-agent', last: structuredClone(roleViews.get(roleId() ?? 'global')?.last ?? null), warning: observed ? null : '宿主尚未经过请求接管入口；需要在隔离 DSH 安装适配补丁后验证。' }),
    dispose() { if (globalThis[REQUEST_HOOK] === transform) delete globalThis[REQUEST_HOOK]; compiler.clear(); presentation.clear(); roleViews.clear(); },
  };
}
