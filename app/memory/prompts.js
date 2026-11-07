/** 旧调用点的兼容导出；正文位于各功能目录的 prompts/*.md，运行配置按调用即时读取。 */
import { readPrompt } from './common/prompt_files.js';
export const SYSTEM_PROMPT = readPrompt('system');
export const UPDATE_PROMPT = readPrompt('update');
export const DIARY_PROMPT = readPrompt('diary');
export const ACTIVITY_PROMPT = readPrompt('activity');
export const PROFILE_PROMPT = readPrompt('profile');
export const SELF_PROFILE_PROMPT = readPrompt('selfProfile');
export const SKILL_PERSONA_PROMPT = readPrompt('skillPersona');
export const SKILL_USER_PROMPT = readPrompt('skillUser');
export const SKILL_MEMORY_PROMPT = readPrompt('skillMemory');
export const SKILL_PRESET_PROMPT = readPrompt('skillPreset');
