/** 宏目录供预设页面和编译器共用，结构化历史不能压成普通字符串。 */
const DEFINITIONS = [
  ['dsh.full', 'DSH 原生提示词全文（按块剔除）', '保留当前 DSH 组装的全部原生提示词分块，按本预设的剔除清单减去指定分块；工具能力不变', 'messages'],
  ['history', '历史对话', '选中的历史消息及压缩摘要，保留完整工具链；摘要替代当前会话被覆盖的原文，按覆盖结束时间排序', 'messages'],
  ['current_user', '本次用户输入', '当前真人消息及附件，或原生定时提醒；定时输入独立开启新轮次', 'messages'],
  ['dsh.preset', 'DSH 预设正文', '所选 DSH 模式提供的非工具提示词', 'text'],
  ['dsh.tool_instructions', '工具说明', 'DSH 与插件提供的工具使用说明', 'text'],
  ['dsh.tools', '工具目录（旧预设兼容）', '重复列出工具名称与用途描述；API tools 已包含名称、描述和参数。无需为 native 工具调用添加此消息，不在常用内容中补齐', 'text'],
  ['dsh.skills', '技能说明', '已收集的技能目录与说明', 'text'],
  ['dsh.runtime', '运行背景', '时间、工作目录等可替换快照；不包含定时提醒、任务完成通知或临时工具提示', 'messages'],
  ['wrx.user_information', '用户信息（静态）', '称呼与常驻信息，不含用户画像条目；适合放前面', 'text'],
  ['wrx.character_information', '角色信息（静态）', '助手名字、性格、背景、关系、说话风格及人设，不含自我画像；适合放前面', 'text'],
  ['wrx.user_profile_full', '用户画像（动态·完整）', '全部用户画像条目，不含称呼与常驻信息；新一轮读取最新资料，可放历史后面。与匹配画像有重叠', 'text'],
  ['wrx.character_profile', '角色画像（动态·完整）', '每轮读取最新自我认知与全部画像条目，不做匹配，不含静态人设；角色匹配暂未提供', 'text'],
  ['wrx.user_profile', '用户画像（动态·匹配）', '代码按当前及上一条用户输入匹配关键词，只发送命中的画像；不含称呼和常驻信息，无命中不发送。与完整画像二选一', 'text'],
  ['wrx.user', '用户信息与画像（旧组合）', '静态用户信息和完整画像的组合；使用拆分项时请关闭此组合', 'text'],
  ['wrx.character', '助手信息与画像（旧组合）', '静态角色信息和自我画像的组合；使用拆分项时请关闭此组合', 'text'],
  ['wrx.memory', '动态记忆组合', '用户匹配资料、系统热记忆、外出组合；日记单独管理', 'text'],
  ['wrx.diaries', '热日记', '最近日记，可独立放在固定前缀；冻结日记不提供', 'text'],
  ['wrx.system_memory', '四表热记忆', '独立四表内容；不要与包含它的动态记忆组合重复使用', 'text'],
  ['wrx.ai_notes', '外出与 AI 笔记', '独立热外出记录；不要与动态记忆组合重复使用', 'text'],
  ['wrx.recall', '召回内容', '本轮向量召回；跨会话正文由历史时间窗口统一管理', 'text'],
  ['char', '角色名称', '当前角色名称', 'text'],
  ['user', '用户名称', '当前用户名称', 'text'],
  ['current_time', '本轮时间', '本轮真实输入时间，按项目时区格式化并在工具续轮冻结', 'text'],
  ['current_date', '本轮日期', '本轮真实输入在项目时区的日期', 'text'],
];
export function listMacros() {
  return DEFINITIONS.map(([name, label, description, kind]) => ({ name, label, description, kind }));
}
export const macroNames = new Set(DEFINITIONS.map(([name]) => name));
