import { getRole, saveRole } from './roles.js';
import { currentRole, scopedConfig, withRole } from './role-context.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from './paths.js';
export { PLUGIN_DIR } from './paths.js';
import { readPromptSet, writePrompt, PROMPT_FILES } from '../memory/common/prompt_files.js';
import { resolveAssistantTarget } from './assistant-target.js';


export const DATA_DIR = resolveDataDir();
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const LOG_PATH = join(DATA_DIR, 'wrx-memory.log');
export const DEFAULT_DB = join(DATA_DIR, 'dsh.sqlite3');

/** 能自己写东西的技能。默认全部 confirm：先出草案，人点头才落盘。 */
export const SKILL_DEFAULTS = {
  persona: { mode: 'confirm' },
  user: { mode: 'confirm' },
  memory: { mode: 'confirm' },
  preset: { mode: 'confirm' },
};

export function defaultConfig() {
  return {
    dbPath: DEFAULT_DB,
    prompting: { enabled: false, historyTurns: 30 },
    timezone: 'Asia/Shanghai',
    user: { name: '用户', core: '' },
    characters: ['dsh'],
    dshCharacters: ['dsh'],
    llm: {
      mode: 'dsh',
      provider: '',
      model: '',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: '',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      temperature: 0.2,
    },
    summary: {
      enabled: false,
      intervalMinutes: 60,
      delaySeconds: 2,
      autoColdEnabled: false,
      autoColdMode: 'interval',
      autoColdHours: 3,
      maxChars: 120000,
    },
    vector: {
      enabled: false,
      apiUrl: '',
      apiKey: '',
      model: '',
      threshold: 0.3,
      maxResults: 16,
      rerankEnabled: false,
      rerankUrl: '',
      rerankKey: '',
      rerankModel: '',
    },
    diary: { enabled: false, hour: 3, retryCooldownMinutes: 360 },
    chatLog: { keepDays: 90 },
    crossSession: { enabled: true, minutes: 60, maxItems: 30, maxCharsPerItem: 200 },
    activity: { enabled: false, hour: 10 },
    profile: { enabled: true, hour: 4 },
    selfProfile: { enabled: true, hour: 5 },
    tavern: {
      enabled: false,
      presetId: '',
      diaryDays: 2,
      activityDays: 2,
      coldEnabled: true,
      coldCheckHours: 6,
      // 到期后的归宿：cold = 向量化、按话题召回；freeze = 冻住，不注入不召回，只能靠工具自己查。
      diaryColdTo: 'freeze',
      activityColdTo: 'cold',
      historyDepth: 0,
      // 注入范围：热 = 每轮直接塞进上下文，冷 = 向量召回时塞进来。
      // 6 个开关分别控制「系统记忆 / 日记 / 外出」的热注入与冷召回。
      inject: {
        hotMemory: true,
        coldMemory: true,
        hotDiary: true,
        coldDiary: true,
        hotActivity: true,
        coldActivity: true,
      },
    },
    skills: {
      enabled: true,
      items: {
        persona: { mode: 'confirm' },
        user: { mode: 'confirm' },
        memory: { mode: 'confirm' },
        preset: { mode: 'confirm' },
      },
    },
    prompts: readPromptSet(),
  };
}

function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && base?.[k] !== null && typeof base?.[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
}

let cache = null;

export function loadConfig() {
  if (cache) return scopedConfig({ ...cache, prompts: readPromptSet() });
  let raw = {};
  try {
    if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    console.error('[wrx-memory] 读取配置失败，使用默认值：', error);
  }
  if (raw?.prompts && Object.keys(raw.prompts).length) {
    throw new Error('检测到旧 config.prompts，请先迁移提示词正文到用户数据目录 prompts/active 对应的 Markdown 文件，再移除 JSON 中的 prompts；不能静默覆盖或忽略旧正文。');
  }
  delete raw.prompts;
  cache = resolveAssistantTarget(merge(defaultConfig(), raw || {}));
  return scopedConfig({ ...cache, prompts: readPromptSet() });
}

export function saveConfig(patch) {
  const next = resolveAssistantTarget(merge(withRole(undefined, loadConfig), patch || {}));
  const promptUpdates = patch?.prompts || {};
  for (const [name, text] of Object.entries(promptUpdates)) {
    if (!PROMPT_FILES[name]) throw new Error('未知提示词：' + name);
    if (typeof text !== 'string' || !text.trim()) throw new Error('提示词不能为空：' + name);
  }
  for (const [name, text] of Object.entries(promptUpdates)) {
    writePrompt(name, text);
  }
  const { prompts: _prompts, ...stored } = next;
  cache = stored;
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(stored, null, 2), 'utf8');
  renameSync(tmp, CONFIG_PATH);
  return loadConfig();
}

/** 对外安全视图：不返回 API Key 明文。 */
export function publicConfig() {
  const c = loadConfig();
  return {
    ...c,
    llm: { ...c.llm, apiKey: c.llm.apiKey ? '***' : '' },
    vector: { ...c.vector, apiKey: c.vector.apiKey ? '***' : '', rerankKey: c.vector.rerankKey ? '***' : '' },
  };
}

export function applyConfigPatch(patch) {
  for (const key of ['characters', 'dshCharacters']) if (patch?.[key] !== undefined) throw new Error('请通过角色管理接口创建角色与绑定');
  const role = currentRole();
  const localKeys = ['prompting', 'summary', 'diary', 'activity', 'selfProfile', 'tavern', 'crossSession', 'skills'];
  if (role && Object.keys(patch || {}).some(key => localKeys.includes(key))) {
    if (role.id === 'default') throw new Error('Default 角色不启用该功能');
    const local = {}, global = {};
    for (const [key, value] of Object.entries(patch)) (localKeys.includes(key) ? local : global)[key] = value;
    const latest = getRole(role.id);
    role.settings = merge(latest.settings || {}, local);
    role.wrxPresetId = latest.wrxPresetId;
    role.presetIds = latest.presetIds;
    role.name = latest.name;
    role.enabled = latest.enabled;
    if (local.prompting?.enabled !== undefined) role.enabled = local.prompting.enabled;
    // 角色配置与全局凭据分开；不把一次请求的角色写入全局选择。
    return saveRoleConfig(role, global);
  }
  // 前端把 key 回传成 *** 时表示未修改。
  const p = JSON.parse(JSON.stringify(patch || {}));
  if (p.llm && p.llm.apiKey === '***') delete p.llm.apiKey;
  if (p.vector && p.vector.apiKey === '***') delete p.vector.apiKey;
  if (p.vector && p.vector.rerankKey === '***') delete p.vector.rerankKey;
  return saveConfig(p);
}

function saveRoleConfig(role, global) {
  saveRole(role);
  if (Object.keys(global).length) withRole(undefined, () => applyConfigPatch(global));
  return loadConfig();
}
