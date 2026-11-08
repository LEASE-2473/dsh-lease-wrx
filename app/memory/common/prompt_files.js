/** WRX Companion prompt_files.py 的 JS 实现：白名单、独立 Markdown、即时读取、原子保存。 */
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN_DIR, resolveDataDir } from '../../common/paths.js';

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
  return join(promptRoot || process.env.LEASE_WRX_PROMPT_ROOT || join(resolveDataDir(), 'prompts', 'active'), file);
}

export function readPrompt(name, { promptRoot } = {}) {
  const file = promptPath(name, promptRoot);
  if (!promptRoot && !process.env.LEASE_WRX_PROMPT_ROOT && !existsSync(file)) return readDefaultPrompt(name);
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) throw new Error('提示词为空：' + name);
  return text; // 不 strip，迁入原字符串与用户空白均保留。
}

export function readPromptSet(options = {}) {
  return Object.fromEntries(Object.keys(PROMPT_FILES).map(name => [name, readPrompt(name, options)]));
}

function readDefaultPrompt(name, { useUserDirectory = true } = {}) {
  const relative = PROMPT_FILES[name];
  const packaged = join(PLUGIN_DIR, 'defaults', 'prompts', relative);
  const installed = existsSync(packaged) ? packaged : join(PLUGIN_DIR, 'app', relative);
  const mirror = join(resolveDataDir(), 'prompts', 'defaults', relative);
  if (useUserDirectory) {
    if (!existsSync(mirror)) {
      try {
        mkdirSync(dirname(mirror), { recursive: true });
        copyFileSync(installed, mirror, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!['EEXIST', 'EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
      }
    }
    if (existsSync(mirror)) {
      const text = readFileSync(mirror, 'utf8');
      if (text.trim()) return text;
    }
  }
  const text = readFileSync(installed, 'utf8');
  if (!text.trim()) throw new Error('默认提示词为空：' + name);
  return text;
}

export function readDefaultPromptSet(options = {}) {
  return Object.fromEntries(Object.keys(PROMPT_FILES).map(name => [name, readDefaultPrompt(name, options)]));
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
