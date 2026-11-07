/** 参考 WRX Companion preset_store 的条目/顺序校验；保留所有未知字段和原始提示词。 */
export function validatePresetState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.presets) ) throw new Error('预设库必须包含 presets 数组');
  const state = structuredClone(value);
  const presetIds = new Set();
  const names = new Set();
  for (const preset of state.presets) {
    if (typeof preset.id !== 'string' || !preset.id.trim() || presetIds.has(preset.id)) throw new Error('预设 ID 必须非空且唯一');
    presetIds.add(preset.id);
    if (typeof preset.name !== 'string' || !preset.name.trim()) throw new Error('预设名称不能为空');
    if (names.has(preset.name)) throw new Error('预设名称不能完全相同');
    names.add(preset.name);
    if (!Array.isArray(preset.prompts)) throw new Error('预设 prompts 必须是数组');
    if (preset.dsh_prompt !== undefined) {
      const policy = preset.dsh_prompt;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !Array.isArray(policy.excluded) || policy.excluded.some(name => typeof name !== 'string' || !name.trim()) || new Set(policy.excluded).size !== policy.excluded.length) throw new Error('DSH 剔除清单必须是不重复的分块名称数组');
    }
    const parameters = preset.generation_parameters;
    if (parameters !== undefined) {
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('生成参数必须是对象');
      if (parameters.enabled !== undefined && typeof parameters.enabled !== 'boolean') throw new Error('生成参数启用状态必须是布尔值');
      if ((parameters.enabled === true || parameters.temperature !== undefined) && (typeof parameters.temperature !== 'number' || !Number.isFinite(parameters.temperature) || parameters.temperature < 0 || parameters.temperature > 2)) throw new Error('温度必须是 0–2 之间的有限数字');
    }
    const ids = new Set();
    for (const entry of preset.prompts) {
      if (!entry || typeof entry.identifier !== 'string' || !entry.identifier.trim() || ids.has(entry.identifier)) throw new Error('条目 identifier 必须非空且唯一');
      ids.add(entry.identifier);
      if (entry.operation !== undefined && !['add', 'delete'].includes(entry.operation)) throw new Error('条目操作必须是 add 或 delete');
      if (entry.operation === 'delete') {
        if (!['section', 'text'].includes(entry.delete_mode)) throw new Error('删除方式必须是 section 或 text');
        if (typeof entry.target !== 'string' || !entry.target.trim()) throw new Error('删除目标不能为空');
      }
      if (entry.content !== undefined && typeof entry.content !== 'string') throw new Error('条目正文必须是文本');
      if (entry.role !== undefined && !['system', 'developer', 'user', 'assistant'].includes(entry.role)) throw new Error('条目角色必须是 system / developer / user / assistant');
      if (entry.source !== undefined && typeof entry.source !== 'string') throw new Error('内容来源必须是宏名称文本');
      if (entry.injection_position !== undefined && !['relative', 'in_chat'].includes(entry.injection_position)) throw new Error('插入方式必须是 relative 或 in_chat');
      if (entry.injection_depth !== undefined && (!Number.isSafeInteger(entry.injection_depth) || entry.injection_depth < 0)) throw new Error('插入深度必须是非负整数');
      if (entry.injection_order !== undefined && !Number.isSafeInteger(entry.injection_order)) throw new Error('同深度排序必须是整数');
    }
    if (preset.prompt_order === undefined) preset.prompt_order = preset.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));
    if (!Array.isArray(preset.prompt_order)) throw new Error('prompt_order 必须是数组');
    const ordered = new Set();
    for (const order of preset.prompt_order) {
      if (!order || !ids.has(order.identifier) || ordered.has(order.identifier)) throw new Error('排序中存在重复或未知条目');
      ordered.add(order.identifier);
    }
    for (const entry of preset.prompts) if (!ordered.has(entry.identifier)) preset.prompt_order.push({ identifier: entry.identifier, enabled: entry.enabled !== false });
  }
  if (!presetIds.has(state.active_preset_id)) state.active_preset_id = state.presets[0]?.id ?? '';
  return state;
}
