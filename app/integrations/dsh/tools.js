import { bindSession } from '../../common/roles.js';
import { withRole } from '../../common/role-context.js';
// WRX原生工具：记忆检索、日记、自主活动、用户画像候选及角色资料读写。
// 系统记忆四表不开放写工具：那由总结管线负责，这里只做只读检索。
import { loadConfig } from '../../common/config.js';
import {
  characterDoc,
  listActivity,
  listDiary,
  saveActivity,
  saveCandidate,
  saveDiary,
  searchMemories,
  updateCharacterDoc,
} from '../../memory/db.js';

const PERSONA_FIELDS = ['name', 'user_name', 'personality', 'background', 'relationship', 'speaking_style', 'system_prompt', 'persona'];

function currentCharacter() {
  const cfg = loadConfig();
  if (Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.length) return cfg.dshCharacters[0];
  if (Array.isArray(cfg.characters) && cfg.characters.length) return cfg.characters[0];
  return 'dsh';
}

function textBlock(value) {
  return [{ type: 'text', text: String(value ?? '') }];
}

function todayInZone(zone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function objectOutput(description, render) {
  return {
    schema: { type: 'object', properties: { text: { type: 'string', description } }, additionalProperties: true },
    render: (args, value) => textBlock(value?.text ?? render?.(value) ?? ''),
  };
}

export function registerTools(ctx) {
  const tools = (typeof ctx.get === 'function' ? ctx.get('tools') : undefined) || ctx.tools;
  const register = tools?.register;
  if (typeof register !== 'function') return [];
  const disposers = [];
  const add = (definition) => {
    try {
      const execute = definition.execute;
      disposers.push(register.call(tools, { ...definition, execute(args, execution) {
        const session = execution?.agent?.session;
        if (!session || session.header?.parentSession) throw new Error('当前会话不启用 WRX');
        const role = bindSession(session, ctx);
        if (!role.enabled) throw new Error('当前 Agent Preset 不启用 WRX');
        return withRole(role, () => execute(args, execution));
      } }));
    } catch (error) {
      ctx.logger?.warn?.('[wrx-memory] 注册工具失败 ' + definition.name + ': ' + error?.message);
    }
  };

  add({
    name: 'wrx_memory_search',
    description: '按关键词查长期记忆（人、事、物品、约定）。上一轮注入不够时再用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的词或短句' },
        limit: { type: 'integer', description: '最多几条，默认 3，上限 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: objectOutput('查到的条目', (value) => value?.text || '没查到相关记忆。'),
    async execute(args) {
      const hits = searchMemories(currentCharacter(), args?.query, args?.limit);
      const text = hits.length
        ? hits.map((hit) => '· [' + hit.kind + '] ' + hit.text).join('\n')
        : '没查到相关记忆。';
      return { text, hits };
    },
  });

  add({
    name: 'wrx_diary_write',
    description: '写今天的日记（追加，不覆盖当天已有的）。想写、有值得留下的东西时再写。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简短标题' },
        content: { type: 'string', description: '日记正文，第一人称' },
        hooks: {
          type: 'array',
          items: { type: 'string' },
          description: '未决事项，一条一句，可省略',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: objectOutput('写入结果'),
    async execute(args) {
      const cfg = loadConfig();
      const content = String(args?.content || '').trim();
      if (!content) throw new Error('日记正文不能为空');
      const id = saveDiary(currentCharacter(), {
        date: todayInZone(cfg.timezone),
        title: String(args?.title || '').trim(),
        content,
        hooks: Array.isArray(args?.hooks) ? args.hooks.map((h) => String(h)).filter(Boolean) : [],
        entryType: 'chat_entry',
      });
      return { text: '日记已写入（' + todayInZone(cfg.timezone) + '）。', id };
    },
  });

  add({
    name: 'wrx_diary_read',
    description: '读日记。给日期读那天，不给就读最近几篇。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，可省略' },
        limit: { type: 'integer', description: '最多几篇，默认 3' },
      },
      additionalProperties: false,
    },
    output: objectOutput('日记内容'),
    async execute(args) {
      const limit = Math.max(1, Math.min(10, Number(args?.limit) || 3));
      const rows = listDiary(currentCharacter(), 200).filter(row => row.injection_mode !== 'freeze');
      const date = String(args?.date || '').trim();
      const picked = (date ? rows.filter((row) => row.diary_date === date) : rows).slice(0, limit);
      if (!picked.length) return { text: date ? date + ' 没有日记。' : '还没有日记。' };
      const body = picked
        .map((row) => '【' + row.diary_date + '】' + (row.title ? row.title + '\n' : '') + row.content)
        .join('\n\n');
      return { text: body };
    },
  });

  add({
    name: 'wrx_profile_candidate',
    description: '把这次对话里用户明确说出、值得长期记住的信息提交为画像候选，等每日任务审。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '主题，如 工作背景、3D打印' },
        keywords: { type: 'array', items: { type: 'string' }, description: '2-5 个触发词' },
        content: { type: 'string', description: '1-3 句用户事实' },
      },
      required: ['tag', 'content'],
      additionalProperties: false,
    },
    output: objectOutput('提交结果'),
    async execute(args) {
      const tag = String(args?.tag || '').trim();
      const content = String(args?.content || '').trim();
      if (!tag || !content) throw new Error('tag 和 content 都要有');
      const keywords = Array.isArray(args?.keywords)
        ? args.keywords.map((word) => String(word).trim()).filter(Boolean).slice(0, 6)
        : [];
      const id = saveCandidate({ tag, keywords, content });
      return { text: '候选已提交（' + tag + '），每日任务会审。', id };
    },
  });

  add({
    name: 'wrx_persona_update',
    description: '改自己的人设字段。所有内容字段都能改：name / user_name / personality / background / relationship / speaking_style / system_prompt / persona。',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: PERSONA_FIELDS, description: '要改的字段' },
        value: { type: 'string', description: '新的完整内容' },
      },
      required: ['field', 'value'],
      additionalProperties: false,
    },
    output: objectOutput('修改结果'),
    async execute(args) {
      const field = String(args?.field || '').trim();
      if (!PERSONA_FIELDS.includes(field)) throw new Error('不认识的字段：' + field);
      const value = String(args?.value || '');
      updateCharacterDoc(currentCharacter(), { [field]: value });
      return { text: '人设字段已更新：' + field };
    },
  });

  add({
    name: 'wrx_persona_read',
    description: '读自己的人设原文（只读，跟 wrx_persona_update 配对）。改任何字段之前先读这里，拿到完整原文再整段回写，不要靠猜。',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: PERSONA_FIELDS, description: '只看某个字段（可选；不给就八个字段全给）' },
      },
      additionalProperties: false,
    },
    output: objectOutput('人设原文'),
    async execute(args) {
      const doc = characterDoc(currentCharacter());
      const field = String(args?.field || '').trim();
      if (field) {
        if (!PERSONA_FIELDS.includes(field)) throw new Error('不认识的字段：' + field);
        const value = String(doc[field] ?? '');
        return { text: value, field, value };
      }
      const fields = {};
      for (const f of PERSONA_FIELDS) fields[f] = String(doc[f] ?? '');
      const text = PERSONA_FIELDS.map((f) => '## ' + f + '\n' + (fields[f] || '（空）')).join('\n\n');
      return { text, fields };
    },
  });

  add({
    name: 'wrx_activity_add',
    description: '记一条外出/自主活动，写进外出记录。title 是标题，content 是第一人称经过，note 是想告诉用户的话。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这次自主活动的简短标题，例如「阅读文章」' },
        content: { type: 'string', description: '活动经过，第一人称，具体到看见的东西' },
        note: { type: 'string', description: '想告诉用户的话，可省略，省略就用 content' },
        mood: { type: 'string', description: '一个词的心情，可省略' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    output: objectOutput('写入结果'),
    async execute(args) {
      const title = String(args?.title || '').trim();
      const content = String(args?.content || '').trim();
      if (!title || !content) throw new Error('title 和 content 都要有');
      const note = String(args?.note || '').trim() || content;
      const id = saveActivity(currentCharacter(), {
        activityType: title.slice(0, 60),
        activityContent: content.slice(0, 4000),
        content: note,
        mood: String(args?.mood || '').trim().slice(0, 200),
      });
      return { text: '已记一条外出：' + title, id };
    },
  });

  add({
    name: 'wrx_activity_read',
    description: '读最近的外出记录（wrx 的「外出」，跟每日外出报告同一处）。她问「今天看了什么」时先来这里翻。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多几条，默认 5，上限 20' },
      },
      additionalProperties: false,
    },
    output: objectOutput('外出记录'),
    async execute(args) {
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
      const rows = listActivity(currentCharacter(), 100).filter(row => row.injection_mode !== 'freeze').slice(0, limit);
      if (!rows.length) return { text: '还没有外出记录。' };
      const text = rows
        .map(
          (row) =>
            (row.occurred_at || row.created_at || '') +
            ' 【' +
            (row.activity_type || '活动') +
            '】' +
            (row.activity_content || row.content || '')
        )
        .join('\n');
      return { text, rows };
    },
  });

  return disposers;
}
