import { addContextSlots } from './slots.js';
import { historyConfigFromFields, toLocalDateTime, describeHistoryWindow } from './history-window.js';

const BASE = '/plugins/dsh-wrx-memory/api/preset';
const PROMPTING = '/plugins/dsh-wrx-memory/api/prompting';
const $ = id => document.getElementById(id);
let baseState = null, owners = [], saving = false, configDirty = false;
const character = new URLSearchParams(location.search).get('character') || 'dsh';
window.wrxHasUnsaved = () => dirty || configDirty || saving;
window.wrxDiscard = () => { dirty = false; configDirty = false; };
let state = null, macros = [], dirty = false, dragged = null, savedConfig = {};

async function api(path, { method = 'GET', body, base = BASE } = {}) {
  const response = await fetch(base + path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ character }), { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `请求失败 ${response.status}`);
  return result;
}
function notice(text, kind = '') { $('notice').textContent = text; $('notice').className = kind; }
function changed() { dirty = true; notice('有未保存的修改；保存后用于下一轮新输入。', 'dirty'); }
function current() { return state?.presets.find(p => p.id === state.active_preset_id); }
function uid(prefix) { return prefix + '-' + (globalThis.crypto?.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')); }
function make(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, fn, title) { const node = make('button', text); node.type = 'button'; node.onclick = fn; if (title) node.title = title; return node; }
function inputField(parent, label, value, onInput, { type = 'text', options, min } = {}) {
  const wrap = make('label', label);
  const input = make(options ? 'select' : 'input');
  if (options) for (const [key, text] of options) { const option = make('option', text); option.value = key; input.append(option); }
  else input.type = type;
  input.value = value ?? '';
  if (min !== undefined) input.min = min;
  input.addEventListener(options ? 'change' : 'input', () => { onInput(type === 'number' ? Number(input.value) : input.value); changed(); });
  wrap.append(input); parent.append(wrap); return input;
}
function ordered(preset) {
  const defs = new Map(preset.prompts.map(p => [p.identifier, p]));
  const list = preset.prompt_order || [];
  const ids = new Set(list.map(o => o.identifier));
  for (const entry of preset.prompts) if (!ids.has(entry.identifier)) list.push({ identifier: entry.identifier, enabled: entry.enabled !== false });
  preset.prompt_order = list;
  return list.map(order => ({ order, entry: defs.get(order.identifier) })).filter(row => row.entry);
}
function move(identifier, targetIndex) {
  const list = current().prompt_order;
  const from = list.findIndex(o => o.identifier === identifier);
  if (from < 0 || targetIndex < 0 || targetIndex >= list.length || from === targetIndex) return;
  const [entry] = list.splice(from, 1); list.splice(targetIndex, 0, entry); changed(); renderEntries();
}
function renderEntries() {
  const opened = new Set([...document.querySelectorAll('.entry')].filter(card => card.querySelector('details')?.open).map(card => card.dataset.identifier));
  const preset = current(); $('entries').replaceChildren(); if (!preset) return;
  const rows = ordered(preset); $('entry-count').textContent = `${rows.length} 个条目`;
  rows.forEach(({ entry, order }, index) => {
    const card = make('article', undefined, 'entry'); card.dataset.identifier = entry.identifier;
    card.classList.toggle('disabled', entry.enabled === false || order.enabled === false);
    const heading = make('div', undefined, 'entry-heading');
    const handle = button('⠿', () => {}, '拖动调整条目顺序'); handle.className = 'drag-handle'; handle.draggable = true; handle.setAttribute('aria-label', `拖动 ${entry.name || entry.identifier}`);
    handle.addEventListener('dragstart', event => { dragged = entry.identifier; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragged); card.classList.add('dragging'); });
    handle.addEventListener('dragend', () => { dragged = null; document.querySelectorAll('.drag-over,.dragging').forEach(n => n.classList.remove('drag-over', 'dragging')); });
    card.addEventListener('dragover', event => { if (dragged && dragged !== entry.identifier) { event.preventDefault(); card.classList.add('drag-over'); } });
    card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) card.classList.remove('drag-over'); });
    card.addEventListener('drop', event => { event.preventDefault(); card.classList.remove('drag-over'); if (dragged) move(dragged, index); dragged = null; });
    const enabled = make('input'); enabled.type = 'checkbox'; enabled.checked = entry.enabled !== false && order.enabled !== false; enabled.setAttribute('aria-label', `启用 ${entry.name || entry.identifier}`);
    enabled.onchange = () => { entry.enabled = enabled.checked; order.enabled = enabled.checked; changed(); card.classList.toggle('disabled', !enabled.checked); renderDshSections(); };
    heading.append(handle, enabled, make('span', `${index + 1}. ${entry.operation === 'delete' ? '【删除】' : ''}${entry.name || entry.identifier}`, 'name'), make('span', entry.operation === 'delete' ? '删除规则' : entry.source ? (macros.find(macro => macro.name === entry.source)?.label || '自动内容') : (entry.marker ? '旧版自动内容' : '自定义正文'), 'badge'));
    const up = button('↑', () => move(entry.identifier, index - 1), '向上移动'); up.disabled = index === 0;
    const down = button('↓', () => move(entry.identifier, index + 1), '向下移动'); down.disabled = index === rows.length - 1;
    heading.append(up, down, button('删除', () => { if (!confirm(`删除条目“${entry.name || entry.identifier}”？保存前仍可重新读取。`)) return; preset.prompts = preset.prompts.filter(p => p.identifier !== entry.identifier); preset.prompt_order = preset.prompt_order.filter(p => p.identifier !== entry.identifier); changed(); renderEntries(); }));
    heading.append(make('span', entry.operation === 'delete' ? '全局匹配 · 未命中跳过' : '按列表顺序', 'position'));
    card.append(heading);
    const details = make('details'); details.open = opened.has(entry.identifier); details.append(make('summary', '编辑发送内容'));
    const body = make('div', undefined, 'entry-body'), fields = make('div', undefined, 'entry-fields');
    inputField(fields, '名称', entry.name || entry.identifier, value => { entry.name = value; heading.querySelector('.name').textContent = `${index + 1}. ${entry.operation === 'delete' ? '【删除】' : ''}${value || entry.identifier}`; });
    if (entry.operation === 'delete') {
      inputField(fields, '删除方式', entry.delete_mode, value => { entry.delete_mode = value; renderEntries(); }, { options: [['section', 'DSH 分块名称（整块删除）'], ['text', '精确原文（删除所有匹配）']] });
      body.append(fields);
      const label = make('label', entry.delete_mode === 'section' ? '分块名称（精确匹配，可手填）' : '要删除的原文（区分大小写、空格和换行，不使用正则）');
      const target = make(entry.delete_mode === 'section' ? 'input' : 'textarea'); target.value = entry.target ?? ''; target.setAttribute('aria-label', entry.delete_mode === 'section' ? '删除分块名称' : '删除原文');
      if (entry.delete_mode === 'section') { target.setAttribute('list', 'dsh-section-names'); target.placeholder = '例如 harness:identity'; }
      else { target.rows = 4; target.placeholder = '例如 You are an AI agent powered by DeepSeek Harness.'; }
      target.oninput = () => { entry.target = target.value; changed(); renderDshSections(); };
      label.append(target); body.append(label, make('p', '删除条目本身不会发送给模型。匹配范围是本轮提示词；未命中直接跳过。禁用此条目即可暂停规则，不受列表位置影响。', 'hint'));
      details.append(body); card.append(details); $('entries').append(card); return;
    }
    inputField(fields, '消息角色', entry.role || 'system', value => entry.role = value, { options: ['system', 'developer', 'user', 'assistant'].map(v => [v, v]) });
    const legacy = { chatHistory: '历史对话＋本次输入', charDefinitions: '助手信息与画像', userDefinitions: '用户信息与画像', worldInfoBefore: '旧世界书（当前无内容提供）', worldInfoAfter: '旧世界书（当前无内容提供）' };
    const options = [['', entry.marker ? `沿用旧标记：${legacy[entry.identifier] || entry.identifier}` : '自己写正文'], ...macros.map(macro => [macro.name, macro.label || macro.name])];
    if (entry.marker) options.push(['__text', '改为自己写正文（解除旧标记）']);
    if (entry.source && !macros.some(macro => macro.name === entry.source)) options.push([entry.source, `暂未发现的来源：${entry.source}`]);
    inputField(fields, '这条发送什么', entry.source || '', value => { entry.source = value === '__text' ? '' : value; if (value === '__text') entry.marker = false; renderEntries(); }, { options });
    body.append(fields);
    const automatic = !!entry.source || entry.marker;
    const selected = macros.find(macro => macro.name === entry.source);
    if (automatic) body.append(make('p', selected ? `${selected.label}：${selected.description}。自动填充，不需要在正文再插宏；可拖到任意位置。` : `旧标记：${legacy[entry.identifier] || entry.identifier}。选择上方中文来源即可替换旧标记行为。`, 'hint'));
    const label = make('label', '正文（可选用下方动态变量）'); const text = make('textarea'); text.value = entry.content || ''; text.spellcheck = false; text.oninput = () => { entry.content = text.value; changed(); }; label.append(text); label.hidden = automatic; body.append(label);
    const macroTools = make('div', undefined, 'toolbar'); const macroPicker = $('macro-select').cloneNode(true); macroPicker.removeAttribute('id');
    macroTools.append(macroPicker, button('插入宏到正文', () => { const value = `{{${macroPicker.value}}}`; const start = text.selectionStart, end = text.selectionEnd; text.value = text.value.slice(0, start) + value + text.value.slice(end); entry.content = text.value; text.focus(); text.setSelectionRange(start + value.length, start + value.length); changed(); }));
    macroTools.hidden = automatic;
    body.append(macroTools);
    details.append(body); card.append(details); $('entries').append(card);
  });
  renderDshSections();
}
function render() {
  $('preset-select').replaceChildren(...state.presets.map(p => { const option = make('option', p.name); option.value = p.id; return option; }));
  $('preset-select').value = state.active_preset_id;
  const empty = !current();
  for (const id of ['preset-name','generation-enabled','generation-temperature','clone-preset','delete-preset','add-entry','add-source','add-delete-entry','add-dsh-slots','use-dsh-full','preview']) $(id).disabled = empty;
  if (empty) {
    $('preset-name').value = ''; $('entries').replaceChildren(); $('entry-count').textContent = '0 个条目';
    $('ownership').textContent = '尚无预设。请新建空白预设或导入你自己的附件；插件不附带个人预设。';
    $('switch-owner').hidden = true; $('dsh-section-list').replaceChildren(); $('dsh-full-status').textContent = '请先新建或导入预设。'; return;
  }
  $('preset-name').value = current().name;
  const parameters = current().generation_parameters ?? {};
  $('generation-enabled').checked = parameters.enabled === true;
  $('generation-temperature').value = parameters.temperature ?? '';
  $('generation-temperature').disabled = parameters.enabled !== true;
  $('delete-preset').disabled = state.presets.length <= 1; renderEntries(); renderDshSections();
  const owner = owners.find(r => r.presetId === current().id && r.id !== character);
  $('ownership').textContent = owner ? `当前预设已绑定${owner.name}，禁止在当前角色下更改。请复制并绑定到当前角色或切换到${owner.name}。` : '此处保存预设正文、排序、温度；实际引用请在角色看板保存绑定。';
  $('switch-owner').hidden = !owner;
  $('switch-owner').onclick = () => {
    if (parent !== window) parent.postMessage({ type: 'wrx-select-role', id: owner.id }, location.origin);
    else location.href = './?character=' + encodeURIComponent(owner.id);
  };
  for (const node of document.querySelectorAll('#entries input,#entries textarea,#entries select,#entries button,.preset-meta input,[aria-label="对话生成参数"] input,#add-entry,#add-source,#add-delete-entry,#add-dsh-slots,#use-dsh-full,#delete-preset,#save,#dsh-section-list input')) if (owner) node.disabled = true;
  if (!owner) { $('save').disabled = false; for (const id of ['preset-name','generation-enabled','add-entry','add-source','add-delete-entry','add-dsh-slots','use-dsh-full']) $(id).disabled = false; }

}
function renderDshSections() {
  const preset = current();
  if (!preset) return;
  const sections = macros.filter(m => m.category === 'sections');
  const deletionRows = ordered(preset).filter(({ entry, order }) => entry.operation === 'delete' && entry.enabled !== false && order.enabled !== false);
  const excluded = new Set([...(preset.dsh_prompt?.excluded ?? []), ...deletionRows.filter(({ entry }) => entry.delete_mode === 'section').map(({ entry }) => entry.target)]);
  const full = ordered(preset).some(({ entry, order }) => entry.source === 'dsh.full' && entry.enabled !== false && order.enabled !== false);
  $('use-dsh-full').textContent = full ? '定位已启用的 DSH 全文条目' : preset.prompts.some(entry => entry.source === 'dsh.full') ? '启用并定位 DSH 全文条目' : '添加 DSH 全文条目';
  $('dsh-full-status').textContent = `${full ? '全文条目已启用' : '当前使用原有加法编排'}；最近请求 ${sections.length} 个分块，${deletionRows.length} 条启用的删除规则。修改后需保存预设。`;
  $('dsh-section-names')?.remove(); const namesList = make('datalist'); namesList.id = 'dsh-section-names';
  for (const section of sections) { const option = make('option'); option.value = section.sectionName; namesList.append(option); } document.body.append(namesList);
  const list = $('dsh-section-list'); list.replaceChildren();
  if (!sections.length) list.append(make('p', '尚未收到原生提示词分块。请在 DSH 发起一次请求后重新读取；不会使用虚构底稿。', 'hint'));
  const names = new Set(sections.map(s => s.sectionName));
  for (const name of [...excluded].filter(name => !names.has(name))) {
    const label = make('label', `剔除 ${name}（最近请求未出现，规则保留）`, 'inline');
    const box = make('input'); box.type = 'checkbox'; box.checked = true;
    box.onchange = () => toggleSectionDeletion(name, false);
    label.prepend(box); list.append(label);
  }
  for (const section of sections) {
    const card = make('details');
    const summary = make('summary');
    const label = make('label', `剔除 ${section.sectionName}`, 'inline');
    const box = make('input'); box.type = 'checkbox'; box.checked = excluded.has(section.sectionName); box.setAttribute('aria-label', `剔除 ${section.sectionName}`);
    box.onclick = event => event.stopPropagation();
    box.onchange = () => toggleSectionDeletion(section.sectionName, box.checked);
    label.prepend(box); summary.append(label); card.append(summary, make('pre', section.text || '（空分块）')); list.append(card);
  }
  $('dsh-full-preview').textContent = sections.filter(s => !excluded.has(s.sectionName) && s.text).map(s => {
    let text = s.text;
    for (const { entry } of deletionRows) if (entry.delete_mode === 'text' && entry.target) text = text.split(entry.target).join('');
    return text;
  }).filter(Boolean).join('\n\n') || '（当前无正文）';
}
function addDeletion(mode = 'section', target = '') {
  const preset = current(); if (!preset) return;
  const entry = { identifier: uid('delete'), name: target || '删除规则', operation: 'delete', delete_mode: mode, target, enabled: true };
  preset.prompts.push(entry); preset.prompt_order.unshift({ identifier: entry.identifier, enabled: true }); return entry;
}
function toggleSectionDeletion(name, checked) {
  const preset = current();
  if (preset.dsh_prompt) preset.dsh_prompt.excluded = preset.dsh_prompt.excluded.filter(value => value !== name);
  const existing = preset.prompts.filter(entry => entry.operation === 'delete' && entry.delete_mode === 'section' && entry.target === name);
  if (checked && !existing.length) addDeletion('section', name);
  for (const entry of existing) { entry.enabled = checked; const order = preset.prompt_order.find(item => item.identifier === entry.identifier); if (order) order.enabled = checked; }
  changed(); renderEntries();
}
$('add-delete-entry').onclick = () => {
  const entry = addDeletion(); if (!entry) return;
  changed(); renderEntries();
  const card = [...$('entries').children].find(node => node.dataset.identifier === entry.identifier);
  card.querySelector('details').open = true; card.scrollIntoView({ block: 'center' }); card.querySelector('[aria-label="删除分块名称"]').focus();
};
$('use-dsh-full').onclick = () => {
  const preset = current(); if (!preset) return;
  let entry = preset.prompts.find(p => p.source === 'dsh.full');
  const existed = Boolean(entry);
  let modified = false;
  if (!entry) {
    entry = { identifier: uid('dsh-full'), name: 'DSH 原生提示词全文（按块剔除）', role: 'system', enabled: true, source: 'dsh.full', content: '' };
    preset.prompts.push(entry); preset.prompt_order.unshift({ identifier: entry.identifier, enabled: true });
    modified = true;
  } else {
    const order = ordered(preset).find(row => row.entry === entry).order;
    modified = entry.enabled === false || order.enabled === false;
    entry.enabled = true; order.enabled = true;
  }
  if (modified) changed();
  renderEntries();
  const card = [...$('entries').children].find(node => node.dataset.identifier === entry.identifier);
  card.querySelector('details').open = true;
  card.scrollIntoView({ block: 'center' });
  card.querySelector('input').focus({ preventScroll: true });
  const message = !existed ? '已添加 DSH 全文条目，请保存预设。' : modified ? '已启用并定位已有的 DSH 全文条目，请保存预设。' : '已定位已有的 DSH 全文条目，未重复添加。';
  notice(message, dirty ? 'dirty' : '');
  $('dsh-full-status').textContent += ' ' + message;
};
function renderMacros() {
  $('macro-select').replaceChildren(...macros.map(m => { const option = make('option', m.label || m.name); option.value = m.name; return option; }));
  $('add-source').disabled = !macros.length;
  document.getElementById('macro-names')?.remove(); const list = make('datalist'); list.id = 'macro-names';
  for (const macro of macros) { const option = make('option'); option.value = macro.name; list.append(option); } document.body.append(list);
  showMacroDescription();
}
function showMacroDescription() { const macro = macros.find(m => m.name === $('macro-select').value); $('macro-description').textContent = macro ? `${macro.label}：${macro.description || ''}。加入后自动填充，无需手写宏。` : '暂无可用内容目录'; }
async function load() {
  if (dirty && !confirm('放弃尚未保存的修改，重新读取？')) return;
  try { const result = await api('/state'); state = result.state; baseState = structuredClone(state); owners = result.owners || []; macros = result.macros || []; dirty = false; renderMacros(); render(); notice('已读取；原有条目全文、排序和附加字段均保留。'); } catch (error) { notice(error.message, 'error'); }
}
function addEntry(source = '') {
  const preset = current(); const macro = macros.find(m => m.name === source);
  const entry = { identifier: uid('prompt'), name: macro?.label || '新提示词', enabled: true, role: 'system', content: '', marker: false, source, injection_position: 'relative', injection_depth: 1, injection_order: 100 };
  preset.prompts.push(entry); preset.prompt_order.push({ identifier: entry.identifier, enabled: true }); changed(); renderEntries(); const card = $('entries').lastElementChild; card.querySelector('details').open = true; card.scrollIntoView({ block: 'center' }); card.querySelector('input:not([type=checkbox])').focus(); notice(`已新增“${entry.name}”，位于列表末尾；可拖动排序，记得保存。`, 'dirty');
}
$('reload').onclick = load;
function presetChanges() {
  const ids = new Set([...baseState.presets, ...state.presets].map(p => p.id));
  return [...ids].map(id => ({ id, before: baseState.presets.find(p => p.id === id) ?? null, after: state.presets.find(p => p.id === id) ?? null })).filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after));
}
$('save').onclick = async () => { if (!state) return; const editor = $('editor'); saving = true; editor.classList.add('busy'); try { const result = await api('/state', { method: 'PUT', body: { changes: presetChanges(), selectedPresetId: state.active_preset_id } }); state = result.state; baseState = structuredClone(state); dirty = false; render(); notice('预设已保存，下一轮新输入使用当前设置。'); } catch (error) { notice(error.message, 'error'); } finally { saving = false; editor.classList.remove('busy'); } };
$('preset-select').onchange = () => { if (dirty && !confirm('保留尚未保存的修改并切换查看？')) { $('preset-select').value = state.active_preset_id; return; } state.active_preset_id = $('preset-select').value; render(); };
$('generation-enabled').onchange = () => {
  const parameters = current().generation_parameters ??= {};
  parameters.enabled = $('generation-enabled').checked;
  $('generation-temperature').disabled = !parameters.enabled;
  changed();
};
$('generation-temperature').oninput = () => {
  const parameters = current().generation_parameters ??= {};
  if ($('generation-temperature').value === '') delete parameters.temperature;
  else parameters.temperature = $('generation-temperature').valueAsNumber;
  changed();
};
$('preset-name').oninput = () => { current().name = $('preset-name').value; $('preset-select').selectedOptions[0].textContent = current().name; changed(); };
$('add-entry').onclick = () => addEntry(); $('add-source').onclick = () => addEntry($('macro-select').value); $('macro-select').onchange = showMacroDescription;
$('add-dsh-slots').onclick = () => {
  if (!current()) return;
  const added = addContextSlots(current(), macros);
  if (added.length) { changed(); renderEntries(); notice(`已加入 ${added.length} 个缺少的内容插槽，尚未保存。原条目正文保持不变，可继续拖动、禁用或删除。`, 'dirty'); }
  else notice('建议内容插槽已经存在，未重复添加；当前编辑不会自动保存。', dirty ? 'dirty' : '');
};
function uniqueName(name) { let value = name, i = 2; while (state.presets.some(p => p.name === value)) value = name + '（' + i++ + '）'; return value; }
$('add-preset').onclick = () => { const preset = { id: uid('preset'), name: uniqueName('新预设'), prompts: [], prompt_order: [] }; state.presets.push(preset); state.active_preset_id = preset.id; changed(); render(); };
$('clone-preset').onclick = () => { const preset = structuredClone(current()); preset.id = uid('preset'); preset.name = uniqueName(preset.name + '（副本）'); state.presets.push(preset); state.active_preset_id = preset.id; changed(); render(); };
$('delete-preset').onclick = () => { if (state.presets.length <= 1 || !confirm(`删除预设“${current().name}”？此操作会删除该预设下所有条目。`)) return; state.presets = state.presets.filter(p => p.id !== state.active_preset_id); state.active_preset_id = state.presets[0]?.id ?? ''; changed(); render(); };
$('export').onclick = () => { if (!state) return; const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })); const link = make('a'); link.href = url; link.download = 'lease-wrx-presets.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async event => { try { const file = event.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) throw new Error('导入文件不能超过 2 MiB'); const data = JSON.parse(await file.text()); const incoming = Array.isArray(data.presets) ? data.presets : data.prompts && data.id ? [data] : null; if (!incoming?.length) throw new Error('请导入 WRX 格式预设或预设集合；当前不接受未经转换的其他格式'); const newPresets = structuredClone(incoming); for (const preset of newPresets) { if (!Array.isArray(preset.prompts) || !preset.id) throw new Error('导入预设缺少 id 或 prompts'); if (state.presets.some(p => p.id === preset.id)) { preset.id = uid('imported');  } } const names = [...state.presets, ...newPresets].map(p => p.name); if (new Set(names).size !== names.length) throw new Error('预设名称不能完全相同，请先在JSON中改名'); state.presets.push(...newPresets); state.active_preset_id = newPresets[0].id; changed(); render(); notice('已追加导入预设；原有预设没有覆盖。请预览并保存。', 'dirty'); } catch (error) { notice(error.message, 'error'); } finally { event.target.value = ''; } };
$('preview').onclick = async () => { try { const history = JSON.parse($('preview-history').value); if (!Array.isArray(history)) throw new Error('历史必须是 JSON 数组'); const result = await api('/preview', { method: 'POST', body: { state, currentUser: $('preview-user').value, history, ...readHistoryConfig() } }); $('preview-summary').textContent = `${result.messages?.length ?? 0} 条消息 · ${result.warnings?.length ?? 0} 项提示`; $('preview-result').textContent = JSON.stringify(result, null, 2); } catch (error) { $('preview-summary').textContent = error.message; } };
function readHistoryConfig() {
  const timestamps = { enabled: $('timestamps-enabled').checked, timeZone: $('timestamps-zone').value.trim() || 'Asia/Shanghai' };
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: timestamps.timeZone }); } catch { throw new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai'); }
  return { ...historyConfigFromFields({ enabled: $('enabled').checked, mode: $('history-mode').value, turns: $('history-turns').value, durationMinutes: $('history-duration').value, since: $('history-since').value }, savedConfig), timestamps, excludeModelSelection: $('exclude-model-selection').checked, midConversationSystem: $('mid-system').value };
}
function showHistoryWindow() {
  const mode = $('history-mode').value;
  $('history-turns-field').hidden = mode !== 'turns';
  $('history-duration-field').hidden = mode !== 'duration';
  $('history-since-field').hidden = mode !== 'since';
  try { $('history-window-summary').textContent = '当前窗口设置：' + describeHistoryWindow(readHistoryConfig()) + '；保存后生效。'; }
  catch (error) { $('history-window-summary').textContent = error.message; }
}
for (const id of ['history-mode', 'history-turns', 'history-duration', 'history-since']) $(id).addEventListener('input', showHistoryWindow);
async function loadConfig() {
  try {
    const [config, status] = await Promise.all([api('/config', { base: PROMPTING }), api('/status', { base: PROMPTING })]);
    const value = config.config || config; savedConfig = value;
    const window = value.historyWindow || {};
    $('enabled').checked = value.enabled === true;
    $('history-mode').value = ['turns', 'since', 'duration'].includes(window.mode) ? window.mode : 'turns';
    $('history-turns').value = window.turns ?? value.historyTurns ?? 30;
    $('history-duration').value = window.durationMinutes ?? 60;
    $('history-since').value = toLocalDateTime(window.since);
    $('exclude-model-selection').checked = value.excludeModelSelection === true;
    $('timestamps-enabled').checked = value.timestamps?.enabled === true;
    $('timestamps-zone').value = value.timestamps?.timeZone || 'Asia/Shanghai';
    $('mid-system').value = value.midConversationSystem === 'user' ? 'user' : 'preserve';
    showHistoryWindow();
    const active = status.status || status;
    $('hook-status').textContent = active.warning || (active.hookRegistered ? '请求接管入口已注册。' : '请求接管入口尚未注册；保存预设不会自动启用宿主补丁。');
  } catch (error) { $('hook-status').textContent = '编排设置暂不可用：' + error.message; }
}
$('save-config').onclick = async () => {
  try {
    notice('正在保存编排设置…');
    await api('/config', { base: PROMPTING, method: 'PUT', body: { ...readHistoryConfig(), baseConfig: savedConfig } });
    configDirty = false; await loadConfig(); notice('编排设置已保存。');
  } catch (error) { notice(error.message, 'error'); }
};
for (const node of document.querySelectorAll('.takeover input,.takeover select')) node.addEventListener('input', () => { configDirty = true; notice('角色启用与历史设置未保存，请点击对应保存按钮。', 'dirty'); });
window.addEventListener('beforeunload', event => { if (dirty || configDirty) { event.preventDefault(); event.returnValue = ''; } });
load(); loadConfig();
