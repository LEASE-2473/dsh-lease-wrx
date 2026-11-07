/** WRX Companion prompt_files.py 的 JS 实现：白名单、独立 Markdown、即时读取、原子保存。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN_DIR } from '../../common/paths.js';

export const PROMPT_FILES = Object.freeze({
  system: 'memory/system_memory/prompts/system.md',
  update: 'memory/system_memory/prompts/system_update.md',
  diary: 'memory/diaries/prompts/diary.md',
  diaryInstant: 'memory/diaries/prompts/diary_instant.md',
  diaryMerge: 'memory/diaries/prompts/diary_merge.md',
  activity: 'memory/ai_notes/prompts/activity.md',
  profile: 'profile/user/prompts/profile_summary.md',
  selfProfile: 'profile/assistant/prompts/profile_summary.md',
  skillPersona: 'skills/prompts/persona.md',
  skillUser: 'skills/prompts/user.md',
  skillMemory: 'skills/prompts/memory.md',
  skillPreset: 'skills/prompts/preset.md',
  MERGE_INSTRUCTION: 'memory/system_memory/prompts/merge.md',
  DIARY_SEGMENT_INSTRUCTION: 'memory/diaries/prompts/segment.md',
  DIARY_MERGE_INSTRUCTION: 'memory/diaries/prompts/daily_merge.md',
});

function promptPath(name, promptRoot) {
  const file = PROMPT_FILES[name];
  if (!file) throw new Error('未知提示词：' + name);
  return join(promptRoot || process.env.LEASE_WRX_PROMPT_ROOT || join(PLUGIN_DIR, 'app'), file);
}

export function readPrompt(name, { promptRoot } = {}) {
  const text = readFileSync(promptPath(name, promptRoot), 'utf8');
  if (!text.trim()) throw new Error('提示词为空：' + name);
  return text; // 不 strip，迁入原字符串与用户空白均保留。
}

export function readPromptSet(options = {}) {
  return Object.fromEntries(Object.keys(PROMPT_FILES).map(name => [name, readPrompt(name, options)]));
}

export function readDefaultPromptSet() {
  return readPromptSet({ promptRoot: join(PLUGIN_DIR, 'defaults', 'prompts') });
}

export function writePrompt(name, text, { promptRoot } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('提示词不能为空：' + name);
  const file = promptPath(name, promptRoot);
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, text, { encoding: 'utf8', flag: 'w' });
  renameSync(temp, file);
  return text;
}
