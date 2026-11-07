/** 显式添加建议插槽；只定义推荐组合，名称和说明使用引擎提供的宏目录。 */
const RECOMMENDED = [
  ['dsh.preset', 'relative'],
  ['dsh.tool_instructions', 'relative'],
  ['dsh.skills', 'relative'],
  ['wrx.diaries', 'relative'],
  ['dsh.runtime', 'relative'],
  ['wrx.memory', 'relative'],
  ['wrx.recall', 'relative'],
];

export function addContextSlots(preset, macros) {
  if (!preset || !Array.isArray(preset.prompts) || !Array.isArray(preset.prompt_order)) throw new Error('当前预设格式无效');
  const catalog = new Map(macros.map(m => [m.name, m]));
  const present = new Set();
  for (const entry of preset.prompts) {
    if (entry.source) present.add(entry.source.replace(/^\{\{|\}\}$/g, '').trim());
    for (const match of String(entry.content ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) present.add(match[1]);
  }
  const prefix = [], suffix = [], added = [];
  for (const [name, position] of RECOMMENDED) {
    if (present.has(name) || !catalog.has(name)) continue;
    let identifier = 'slot:' + name;
    while (preset.prompts.some(p => p.identifier === identifier)) identifier += '-new';
    preset.prompts.push({ identifier, name: catalog.get(name).label || name, role: 'system', enabled: true, marker: false, content: '', source: name, injection_position: position, injection_depth: 1, injection_order: 100 });
    (position === 'relative' ? prefix : suffix).push({ identifier, enabled: true });
    added.push(name);
  }
  preset.prompt_order = [...prefix, ...preset.prompt_order, ...suffix];
  return added;
}
