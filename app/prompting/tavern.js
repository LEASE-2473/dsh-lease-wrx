import { loadConfig } from '../common/config.js'
import { characterDoc, listActivity, listDiary, listRows, readSelf, readUser } from '../memory/db.js'
import { charDefinition, loadPresets, userProfileText } from '../preset/service.js'

function expandMacros(text, { char, user, now }) {
  return String(text || '')
    .replace(/\{\{\s*char\s*\}\}/gi, char || '当前角色')
    .replace(/\{\{\s*user\s*\}\}/gi, user || '用户')
    .replace(/\{\{\s*current_time\s*\}\}/gi, '')
    .replace(/\{\{\s*char_status_rules\s*\}\}/gi, '')
    .replace(/\{\{\s*char_status\s*\}\}/gi, '')
}

/** 我的画像：紧跟在角色定义后面，每轮全量注入。每天只有一份，是稳定前缀，不吃缓存。 */
function selfProfileBlock() {
  const self = readSelf()
  const entries = Array.isArray(self.entries) ? self.entries : []
  if (!entries.length) return ''
  const lines = ['[我的画像｜DS 自己的状态｜每轮全量]']
  for (const e of entries) {
    const content = String(e?.content || '').trim()
    if (!content) continue
    lines.push('[' + (e.tag || '条目') + '] ' + content)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

export function compileTavernPreset(presets, doc, user) {
  const cfg = loadConfig()
  const preset = presets.presets.find((p) => p.id === cfg.tavern?.presetId)
    || presets.presets.find((p) => p.id === presets.active_preset_id)
    || presets.presets[0]
  if (!preset) return ''
  const now = new Date().toLocaleString('zh-CN', { timeZone: cfg.timezone || 'Asia/Shanghai', hour12: false })
  const defs = new Map((preset.prompts || []).map((p) => [p.identifier, p]))
  const order = preset.prompt_order?.length
    ? preset.prompt_order
    : (preset.prompts || []).map((p) => ({ identifier: p.identifier, enabled: true }))
  const parts = []
  for (const entry of order) {
    const prompt = defs.get(entry.identifier)
    if (!prompt) continue
    if (entry.enabled === false || prompt.enabled === false) continue
    if (prompt.marker) {
      if (prompt.identifier === 'charDefinitions') {
        const def = charDefinition(doc)
        if (def) parts.push('[角色定义]\n' + def)
        // ⭐ 2026-10-26：我的画像紧跟角色定义（固定前缀，每轮全量，不动缓存）
        const mine = selfProfileBlock()
        if (mine) parts.push(mine)
      }
      continue
    }
    const content = expandMacros(prompt.content, { char: doc?.name, user: user?.name, now }).trim()
    if (content) parts.push(content)
  }
  return parts.join('\n\n')
}

export function userProfileBlock(user, currentInput, previousInput) {
  const haystack = [previousInput, currentInput].filter(Boolean).join('\n').toLowerCase()
  const selected = (user.entries || []).filter((e) =>
    (e.keywords || []).some((k) => k && haystack.includes(String(k).toLowerCase())))
  const lines = ['[全局用户资料｜背景资料]', '称呼：' + (user.name || '用户')]
  if (user.core) lines.push('核心信息：' + user.core)
  for (const e of selected) lines.push('[' + (e.tag || '') + ']\n' + e.content)
  return lines.join('\n')
}

/** 注入里的时间：所有记录都带上"什么时候发生的"，别光秃秃一段文本。 */
function fmtAt(value, tz) {
  const s = String(value || '')
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ')
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const get = (type) => parts.find((p) => p.type === type)?.value || ''
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute')
  } catch {
    return s.slice(0, 16).replace('T', ' ')
  }
}

function diaryBlock(characterId, days) {
  const tz = loadConfig().timezone || 'Asia/Shanghai'
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  // 只注入「热」的：冷 = 已向量化走召回，转冷中 = 还没转完，两个都不进上下文。
  const list = (listDiary(characterId, 20) || []).filter((d) => d.diary_date >= cutoff && d.injection_mode === 'hot')
  if (!list.length) return ''
  return '[最近日记｜背景资料]\n' + list.map((d) => '[' + d.diary_date + '] ' + (d.title || '') + '\n' + d.content).join('\n\n')
}

function activityBlock(characterId, days) {
  const tz = loadConfig().timezone || 'Asia/Shanghai'
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const list = (listActivity(characterId, 20) || []).filter((n) =>
    String(n.occurred_at || n.created_at || '') >= cutoff && n.injection_mode === 'hot')
  if (!list.length) return ''
  return '[最近外出｜背景资料]\n' + list.map((n) =>
    '[' + fmtAt(n.occurred_at || n.created_at, tz) + '] ' + (n.activity_type || '活动') + '：' + (n.activity_content || n.content || '')).join('\n\n')
}

function memoryBlock(characterId) {
  const tz = loadConfig().timezone || 'Asia/Shanghai'
  const rows = (listRows(characterId) || []).filter((r) => r.mode === 'hot')
  if (!rows.length) return ''
  const when = (r) => {
    const at = fmtAt(r.range_start || r.range_end, tz)
    return at ? '[' + at + '] ' : ''
  }
  const line = (r) => {
    if (r.kind === 'summary') return '· ' + when(r) + r.content + (r.tag ? '（' + r.tag + '）' : '')
    if (r.kind === 'agreement') return '· ' + when(r) + '[约定] ' + r.content
    if (r.kind === 'person') return '· ' + when(r) + '[人物] ' + r.name + '：' + [r.relationship, r.history, r.impression].filter(Boolean).join('；')
    return '· ' + when(r) + '[物品] ' + r.name + '：' + [r.description, r.location].filter(Boolean).join('；')
  }
  return '[系统记忆｜热记录]\n' + rows.map(line).join('\n')
}

/** 固定段：预设正文 + 角色定义 + 日记。放 system，位置在 DSH 提示词之后。
 *  2026-10-26：活动记录从这里挪走了——我出门一趟就写一条，前缀每趟都被冲掉，缓存全炸。
 *  日记一天只变一次，留着还划算；活动随时在变，必须走 late。 */
export function tavernFixedText(characterId, { force = false } = {}) {
  const cfg = loadConfig()
  if (!cfg.tavern?.enabled && !force) return ''
  try {
    const doc = characterDoc(characterId)
    const user = readUser()
    const inject = cfg.tavern?.inject || {}
    const parts = [
      compileTavernPreset(loadPresets(), doc, user),
      inject.hotDiary === false ? '' : diaryBlock(characterId, Number(cfg.tavern.diaryDays) || 2),
    ].filter(Boolean)
    if (!parts.length) return ''
    return '【DSH 酒馆上下文｜固定段】\n\n' + parts.join('\n\n')
  } catch {
    return ''
  }
}

/** 数据段：用户资料 + 热记忆 + 最近外出。热对话和召回由调用方追加。
 *  外出挪到这里的理由见 tavernFixedText：它每趟都在变，放固定段会一直炸前缀。 */
export function tavernDataText(characterId, currentInput = '', previousInput = '', { force = false } = {}) {
  const cfg = loadConfig()
  if (!cfg.tavern?.enabled && !force) return ''
  try {
    const user = readUser()
    const inject = cfg.tavern?.inject || {}
    const parts = [
      userProfileBlock(user, currentInput, previousInput),
      inject.hotActivity === false ? '' : activityBlock(characterId, Number(cfg.tavern.activityDays) || 2),
      inject.hotMemory === false ? '' : memoryBlock(characterId),
    ].filter(Boolean)
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

/** 每轮重新编译的酒馆上下文；不是历史消息，是 system 段。force=true 给预览用。 */
export function tavernText(characterId, currentInput = '', previousInput = '', { force = false } = {}) {
  const fixed = tavernFixedText(characterId, { force })
  const data = tavernDataText(characterId, currentInput, previousInput, { force })
  return [fixed, data].filter(Boolean).join('\n\n')
}

export function memoryPromptSources(characterId, currentInput = '', previousInput = '') {
  const cfg = loadConfig()
  const inject = cfg.tavern?.inject || {}
  return {
    'wrx.diaries': inject.hotDiary === false ? '' : diaryBlock(characterId, Number(cfg.tavern?.diaryDays) || 2),
    'wrx.system_memory': inject.hotMemory === false ? '' : memoryBlock(characterId),
    'wrx.ai_notes': inject.hotActivity === false ? '' : activityBlock(characterId, Number(cfg.tavern?.activityDays) || 2),
    'wrx.user_profile': userProfileText(readUser(), { currentInput, previousInput, matched: true }),
  }
}
