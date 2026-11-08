import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR, applyConfigPatch, loadConfig } from '../common/config.js'
import { readDshMessages } from '../integrations/dsh/source.js'
import { applyFourTables, characterDoc, readUser, updateCharacterDoc, writeUser } from '../memory/db.js'
import { complete } from '../providers/llm.js'
import { loadPresets, savePresets } from '../preset/service.js'
import { SKILL_MEMORY_PROMPT, SKILL_PERSONA_PROMPT, SKILL_PRESET_PROMPT, SKILL_USER_PROMPT } from '../memory/prompts.js'

const draftsDir = () => join(DATA_DIR, 'drafts', encodeURIComponent(charId()))
const auditPath = () => join(draftsDir(), 'skills-audit.jsonl')

/** 能自己写东西的技能。默认全部 confirm：先出草案，人点头才落盘。 */
export const SKILLS = {
  persona: { label: '我的人设', hint: '把最近聊天里「我」的样子整理成角色卡。' },
  user: { label: '你的人设', hint: '从聊天里提炼你的称呼、习惯和偏好。' },
  memory: { label: '记忆', hint: '把一个时间窗的聊天整理成四表记忆，先出草案。' },
  preset: { label: '预设条目', hint: '写一条新的提示词条目，塞进当前预设。' },
}

const CHARACTER_FIELDS = ['name', 'user_name', 'personality', 'background', 'relationship', 'speaking_style', 'system_prompt', 'persona']

function ensureDrafts() {
  mkdirSync(draftsDir(), { recursive: true })
}

export function audit(entry) {
  try {
    ensureDrafts()
    appendFileSync(auditPath(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* noop */ }
}

export function auditTail(limit = 30) {
  try {
    const lines = readFileSync(auditPath(), 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
  } catch {
    return []
  }
}

function charId() {
  const cfg = loadConfig()
  return cfg.dshCharacters?.[0] || cfg.characters?.[0] || 'dsh'
}

function skillState(id) {
  const cfg = loadConfig()
  const item = cfg.skills?.items?.[id] || {}
  const mode = item.mode || 'confirm'
  const grantUntil = item.grantUntil || null
  const granted = mode === 'auto' && Boolean(grantUntil) && Date.parse(grantUntil) > Date.now()
  return { enabled: cfg.skills?.enabled !== false, mode, grantUntil, granted }
}

export function skillsState() {
  const items = {}
  for (const id of Object.keys(SKILLS)) {
    items[id] = { id, ...SKILLS[id], ...skillState(id) }
  }
  return { enabled: skillState('persona').enabled, items, drafts: listDrafts() }
}

export function grantSkill(id, mode, minutes = 60) {
  if (!SKILLS[id]) throw new Error('未知技能：' + id)
  if (!['confirm', 'auto', 'off'].includes(mode)) throw new Error('模式只能是 confirm / auto / off')
  const patch = { skills: { items: { [id]: { mode } } } }
  if (mode === 'auto') {
    const mins = Math.max(1, Math.min(24 * 30, Number(minutes) || 60))
    patch.skills.items[id].grantUntil = new Date(Date.now() + mins * 60000).toISOString()
  }
  applyConfigPatch(patch)
  audit({ action: 'grant', skill: id, mode, minutes: mode === 'auto' ? Number(minutes) || 60 : null, source: 'ui' })
  return skillsState()
}

export function listDrafts() {
  ensureDrafts()
  const out = []
  for (const file of readdirSync(draftsDir())) {
    if (!file.endsWith('.json')) continue
    try {
      const draft = JSON.parse(readFileSync(join(draftsDir(), file), 'utf8'))
      out.push({
        id: draft.id,
        skill: draft.skill,
        createdAt: draft.createdAt,
        title: draft.title,
        range: draft.range,
      })
    } catch { /* 跳过坏文件 */ }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function readDraft(id) {
  if (!/^[a-z0-9-]+$/i.test(String(id || ''))) throw new Error('草案 id 不合法')
  const path = join(draftsDir(), id + '.json')
  if (!existsSync(path)) throw new Error('草案不存在：' + id)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function discardDraft(id) {
  const draft = readDraft(id)
  unlinkSync(join(draftsDir(), id + '.json'))
  audit({ action: 'discard', skill: draft.skill, draft: id })
  return { ok: true, id }
}

function stripFence(text) {
  return String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

function extractJson(text) {
  const raw = stripFence(text)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('模型没有返回 JSON：' + raw.slice(0, 200))
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    throw new Error('模型返回的 JSON 不完整：' + error.message)
  }
}

function transcriptOf(messages) {
  return messages.map((m) => {
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : String(m.role || '')
    return `${who}：${String(m.content || '')}`
  }).join('\n')
}

function draftTitle(skill, data) {
  if (skill === 'persona') return '我的人设草案'
  if (skill === 'user') return '你的人设草案'
  if (skill === 'memory') return '记忆草案'
  if (skill === 'preset') return '预设条目：' + (data.name || data.identifier || '未命名')
  return '草案'
}

// 草案不设置本地输出上限；端点容量不足时明确失败。

export async function draftSkill(ctx, skill, opts = {}) {
  if (!SKILLS[skill]) throw new Error('未知技能：' + skill)
  const state = skillsState()
  if (!state.enabled) throw new Error('技能总开关关着')
  const hours = Math.max(1, Math.min(24 * 30, Number(opts.hours) || 72))
  const end = new Date()
  const start = new Date(end.getTime() - hours * 3600000)
  const messages = await readDshMessages(ctx, { character: charId(), start: start.toISOString(), end: end.toISOString() })
  if (!messages || !messages.length) throw new Error(`最近 ${hours} 小时没有聊天记录，先聊两句再来起草`)
  const transcript = transcriptOf(messages)
  const cfg = loadConfig()
  const character = characterDoc(charId())
  const user = readUser()

  const pickPrompt = (key, fallback) => {
    const v = cfg?.prompts?.[key]
    return typeof v === 'string' && v.trim() ? v : fallback
  }
  let system
  if (skill === 'persona') {
    system = pickPrompt('skillPersona', SKILL_PERSONA_PROMPT)
  } else if (skill === 'user') {
    system = pickPrompt('skillUser', SKILL_USER_PROMPT)
  } else if (skill === 'memory') {
    system = pickPrompt('skillMemory', SKILL_MEMORY_PROMPT)
  } else {
    system = pickPrompt('skillPreset', SKILL_PRESET_PROMPT)
  }

  const payload = [
    '现有角色卡：',
    JSON.stringify(character),
    '',
    '现有用户画像：',
    JSON.stringify(user),
    '',
    '最近聊天记录：',
    transcript,
  ].join('\n')

  const raw = await complete(ctx, cfg, {
    system,
    messages: [{ role: 'user', text: payload }],
    maxTokens: 0,
  })
  const data = extractJson(raw)
  const draft = {
    id: `draft-${skill}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    skill,
    createdAt: new Date().toISOString(),
    hours,
    range: { start: start.toISOString(), end: end.toISOString() },
    title: draftTitle(skill, data),
    data,
  }
  ensureDrafts()
  writeFileSync(join(draftsDir(), draft.id + '.json'), JSON.stringify(draft, null, 2), 'utf8')
  audit({ action: 'draft', skill, draft: draft.id, source: opts.source || 'ui' })
  return draft
}

function sanitizeCharacter(data) {
  const out = {}
  for (const key of CHARACTER_FIELDS) {
    if (data?.[key] === undefined || data?.[key] === null) continue
    out[key] = String(data[key])
  }
  if (out.name !== undefined && !out.name.trim()) delete out.name
  return out
}

function applyPresetEntry(entry) {
  const state = loadPresets()
  const preset = state.presets.find((p) => p.id === state.active_preset_id) || state.presets[0]
  if (!preset) throw new Error('没有预设可以写')
  const identifier = String(entry.identifier || '').trim() || 'skill-' + Date.now().toString(36)
  if (!/^[a-z0-9_-]+$/i.test(identifier)) throw new Error('条目标识只能用字母、数字、下划线、短横线：' + identifier)
  if ((preset.prompts || []).some((p) => p.identifier === identifier)) throw new Error('条目标识已存在：' + identifier)
  preset.prompts = [...(preset.prompts || []), {
    identifier,
    name: String(entry.name || identifier).trim() || identifier,
    content: String(entry.content || '').trim(),
    enabled: true,
  }]
  preset.prompt_order = [...(preset.prompt_order || []), { identifier, enabled: true }]
  return savePresets(state)
}

export function applyDraft(id, { source = 'ui', confirmed = false } = {}) {
  const draft = readDraft(id)
  const state = skillState(draft.skill)
  if (!state.enabled) throw new Error('技能总开关关着')
  if (state.mode === 'off') throw new Error('这个技能被关掉了')
  if (state.mode === 'auto' && !state.granted) throw new Error('auto 授权已过期，重新授权再试')
  if (state.mode === 'confirm' && !confirmed) throw new Error('confirm 模式需要人点头：页面点「采用」，或明确说「就这么写」')
  const data = draft.data || {}
  let result
  if (draft.skill === 'persona') {
    result = { character: updateCharacterDoc(charId(), sanitizeCharacter(data)) }
  } else if (draft.skill === 'user') {
    const current = readUser()
    result = {
      user: writeUser({
        name: data.name || current.name,
        core: data.core !== undefined ? data.core : current.core,
        entries: Array.isArray(data.entries) ? data.entries : current.entries,
      }),
    }
  } else if (draft.skill === 'memory') {
    result = { applied: applyFourTables(charId(), 'dsh-skill', draft.range.start, draft.range.end, data) }
  } else if (draft.skill === 'preset') {
    result = { preset: applyPresetEntry(data) }
  } else {
    throw new Error('未知技能：' + draft.skill)
  }
  unlinkSync(join(draftsDir(), id + '.json'))
  audit({ action: 'apply', skill: draft.skill, draft: id, source, confirmed })
  return { ok: true, ...result }
}
