/** 预设业务服务及用户/角色资料的宏内容格式化。 */
import { presetStore } from './store.js';
export const loadPresets = () => presetStore.loadForRole();
export const savePresets = state => presetStore.save(state);

export function charDefinition(doc) {
  const lines = [];
  const push = (label, value) => { if (value && String(value).trim()) lines.push(label + '：' + String(value).trim()); };
  push('名字', doc.name);
  push('性格', doc.personality);
  push('背景', doc.background);
  push('关系', doc.relationship);
  push('说话风格', doc.speaking_style);
  push('设定', doc.system_prompt);
  push('人设补充', doc.persona);
  return lines.join('\n');
}

export function userDefinition(user, fallbackName) {
  const lines = [];
  const name = user?.name || fallbackName || '用户';
  lines.push('称呼：' + name);
  if (user?.core) lines.push('常驻信息：' + user.core);
  for (const entry of user?.entries || []) {
    if (entry?.tag && entry?.content) lines.push('[' + entry.tag + '] ' + entry.content);
  }
  return lines.join('\n');
}

export function userProfileText(user, { currentInput = '', previousInput = '', matched = false } = {}) {
  const text = [previousInput, currentInput].filter(Boolean).join('\n').toLowerCase();
  return (user?.entries || []).filter(entry => entry?.content && (!matched ||
    (entry.keywords || []).some(keyword => typeof keyword === 'string' && keyword.trim() && text.includes(keyword.trim().toLowerCase()))))
    .map(entry => '[' + (entry.tag || '条目') + '] ' + entry.content).join('\n');
}

export function profilePromptSources(doc, user, self) {
  const userInformation = userDefinition({ name: user?.name, core: user?.core }, doc?.user_name);
  const userProfile = userProfileText(user);
  const characterInformation = charDefinition(doc);
  const characterProfile = (self?.entries ?? []).map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).filter(Boolean).join('\n\n');
  return {
    'wrx.user_information': userInformation,
    'wrx.character_information': characterInformation,
    'wrx.user_profile_full': userProfile,
    'wrx.character_profile': characterProfile,
    'wrx.user': userDefinition(user, doc?.user_name),
    'wrx.character': [characterInformation, characterProfile].filter(Boolean).join('\n\n'),
  };
}
