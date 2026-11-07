/** 参考 WRX Companion 的纯编译入口：只使用传入快照，不访问文件、数据库或模型。 */
import { macroNames } from '../macros/index.js';
import { createHash } from 'node:crypto';
import { assertToolPairs, splitConversation } from '../history/index.js';
import { mergeSharedHistory } from '../history/shared.js';

const MARKERS = { charDefinitions: 'wrx.character', userDefinitions: 'wrx.user', worldInfoBefore: 'worldInfoBefore', worldInfoAfter: 'worldInfoAfter' };
const structured = new Set(['history', 'current_user', 'dsh.runtime', 'dsh.full']);
const legacyDshSource = name => ['dsh.preset', 'dsh.tool_instructions', 'dsh.skills'].includes(name) || name.startsWith('dsh.sections.');
function textMessage(role, text, name) {
  const id = 'lease-wrx-' + createHash('sha256').update(JSON.stringify([name, role, text])).digest('hex').slice(0, 32);
  return { id, role, content: [{ type: 'text', text }], source: { kind: 'lease-wrx', section: name } };
}
export function compilePrompt({ state, messages = [], sources = {}, historyTurns = 30, historyWindow, sharedHistory = [], messageTimes = {} }) {
  const preset = state?.presets?.find(p => p.id === state.active_preset_id) ?? state?.presets?.[0];
  if (!preset) throw new Error('没有可用预设');
  const conversation = splitConversation(messages, historyWindow?.turns ?? historyTurns, { window: historyWindow, messageTimes });
  if (historyWindow && historyWindow.mode !== 'turns') conversation.history = mergeSharedHistory(conversation.history, sharedHistory, messageTimes);
  const values = { ...sources, history: conversation.history, current_user: conversation.current, 'dsh.runtime': sources['dsh.runtime'] ?? conversation.runtime };
  const definitions = new Map((preset.prompts ?? []).map(p => [p.identifier, p]));
  const order = preset.prompt_order?.length ? preset.prompt_order : (preset.prompts ?? []).map(p => ({ identifier: p.identifier }));
  const warnings = [];
  if (conversation.boundaryExtended) warnings.push('时间边界落在工具调用组内，已补齐该组调用和结果以保留协议完整性');
  if (conversation.missingTimes) warnings.push(`${conversation.missingTimes} 条历史缺少原始时间，未单独按时间纳入；当前真实输入始终保留`);
  const trace = [];
  const deletions = order.flatMap(item => {
    const entry = definitions.get(item.identifier);
    if (!entry || item.enabled === false || entry.enabled === false || entry.operation !== 'delete') return [];
    if (!['section', 'text'].includes(entry.delete_mode) || typeof entry.target !== 'string' || !entry.target.trim()) throw new Error('删除条目的方式或目标无效');
    return [{ identifier: entry.identifier, operation: 'delete', mode: entry.delete_mode, target: entry.target, matches: 0, count: 0 }];
  });
  const sectionRules = deletions.filter(rule => rule.mode === 'section');
  if (sectionRules.length && !sources._dshSections?.length) warnings.push('未收到原生分块，按名称删除暂未命中；不会猜测要删除的正文');
  const dshSections = sources._dshSections?.filter(section => {
    const matched = sectionRules.filter(rule => rule.target === section.sectionName);
    for (const rule of matched) rule.matches++;
    if (matched.length) { values[section.name] = ''; return false; }
    return true;
  });
  if (sectionRules.length && sources._dshSections?.length) {
    const tool = section => /tool|mcp|sdk/i.test(section.sectionName);
    const skill = section => /skill/i.test(section.sectionName);
    const join = sections => sections.map(section => section.text).filter(Boolean).join('\n\n');
    values['dsh.preset'] = join(dshSections.filter(section => !tool(section) && !skill(section)));
    values['dsh.tool_instructions'] = join(dshSections.filter(section => tool(section) && !skill(section)));
    values['dsh.skills'] = join(dshSections.filter(skill));
  }
  const textRules = deletions.filter(rule => rule.mode === 'text');
  function emit(role, text, identifier) {
    for (const rule of textRules) {
      const parts = text.split(rule.target);
      rule.matches += parts.length - 1;
      text = parts.join('');
    }
    return text && (!textRules.length || text.trim()) ? [textMessage(role, text, identifier)] : [];
  }
  const output = [];
  const used = new Set();
  let hasHistory = false;
  let hasCurrent = false;
  const fullEntries = order.filter(item => {
    const entry = definitions.get(item.identifier);
    return entry && entry.operation !== 'delete' && item.enabled !== false && entry.enabled !== false && (entry.source ? entry.source.replace(/^\{\{|\}\}$/g, '').trim() === 'dsh.full' : /\{\{\s*dsh\.full\s*\}\}/.test(entry.content ?? ''));
  });
  const fullMode = fullEntries.length > 0;
  const excluded = new Set(preset.dsh_prompt?.excluded ?? []);
  if (fullMode) {
    if (!Array.isArray(sources._dshSections)) warnings.push('尚未收到 DSH 原生提示词分块；全文暂为空，请在 DSH 发起一次新输入后重新读取');
    const blocks = (dshSections ?? []).filter(section => !excluded.has(section.sectionName) && section.text).flatMap(section => emit('system', section.text, section.name));
    const fullText = blocks.map(message => message.content[0].text).join('\n\n');
    values['dsh.full'] = fullText ? [textMessage('system', fullText, 'dsh.full')] : [];
    // 全文入口接管原生 sections。工具目录由实际 tools 生成，继续按独立开关发送。
    for (const name of Object.keys(values)) if (legacyDshSource(name)) values[name] = '';
  }
  let fullSent = false;
  function resolve(name, role, identifier) {
    if (fullMode && legacyDshSource(name)) return [];
    if (name === 'dsh.full') {
      if (fullSent) { warnings.push(`重复全文入口 ${identifier} 已跳过`); return []; }
      fullSent = true;
      return (values[name] ?? []).map(message => ({ ...message, role }));
    }
    if (!(name in values) && !structured.has(name)) warnings.push(`未提供内容源 ${name}，本轮为空`);
    if (structured.has(name)) {
      if (used.has(name)) throw new Error(`结构化宏 ${name} 只能出现一次`);
      used.add(name);
      if (name === 'history') hasHistory = true;
      if (name === 'current_user') hasCurrent = true;
      const value = values[name] ?? [];
      if (!Array.isArray(value)) throw new Error(`${name} 必须是消息数组`);
      return value;
    }
    const value = values[name];
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value;
    return emit(role, String(value), identifier);
  }
  for (const item of order) {
    const entry = definitions.get(item.identifier);
    if (!entry) { warnings.push(`缺少条目：${item.identifier}`); continue; }
    if (item.enabled === false || entry.enabled === false) continue;
    if (entry.operation === 'delete') continue;
    const role = entry.role ?? 'system';
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw new Error(`条目 ${entry.identifier} 的角色无效`);
    let expanded;
    if (entry.source) expanded = resolve(entry.source.replace(/^\{\{|\}\}$/g, '').trim(), role, entry.identifier);
    else if (entry.marker && entry.identifier === 'chatHistory') {
      // 兼容 WRX 原预设：chatHistory 代表历史及当前输入，不改变原条目内容。
      expanded = [...resolve('history', role, entry.identifier), ...resolve('current_user', role, entry.identifier)];
    } else if (entry.marker) expanded = resolve(MARKERS[entry.identifier] ?? entry.identifier, role, entry.identifier);
    else {
      const content = String(entry.content ?? '');
      const exact = content.trim().match(/^\{\{\s*([\w.]+)\s*\}\}$/);
      if (exact && structured.has(exact[1])) expanded = resolve(exact[1], role, entry.identifier);
      else {
        const text = content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (full, name) => {
          if (fullMode && legacyDshSource(name)) return '';
          if (structured.has(name) || name === 'dsh.full') throw new Error(`结构化宏 ${name} 必须独占一个条目`);
          if (!macroNames.has(name) && !(name in values)) { warnings.push(`未展开宏 ${full}，已保留原文`); return full; }
          const value = values[name];
          if (Array.isArray(value)) throw new Error(`宏 ${name} 是消息列表，不能嵌入文本`);
          return value == null ? '' : String(value);
        });
        expanded = text ? emit(role, text, entry.identifier) : [];
      }
    }
    const record = { identifier: entry.identifier, count: expanded.length, position: 'relative' };
    trace.push(record);
    output.push(...expanded);
  }
  // 历史可关闭，当前真实输入始终保留；不把它挪到工具结果之后。
  if (!hasCurrent) output.push(...conversation.current);
  if (!hasHistory && conversation.history.length) warnings.push('未启用历史宏，本次不发送先前回合');
  const result = [...output, ...conversation.continuation];
  assertToolPairs(result);
  return { messages: result, trace: [...trace, ...deletions], warnings, presetId: preset.id };
}
