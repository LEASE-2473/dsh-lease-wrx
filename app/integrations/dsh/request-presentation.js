import { isHumanMessage, messageTime } from '../../prompting/history/index.js';

export function presentRequest(messages, { timestamps = {}, midConversationSystem = 'preserve', timeZone = 'Asia/Shanghai' } = {}, messageTimes = {}) {
  if (!['preserve', 'user'].includes(midConversationSystem)) throw new Error('midConversationSystem 必须为 preserve 或 user');
  const warnings = [];
  let started = false;
  const presented = messages.map(message => {
    let next = message;
    if (timestamps.enabled && isHumanMessage(message) && !message.leaseWrxTimestamp) {
      const time = messageTime(message, messageTimes);
      if (time == null) warnings.push(`用户消息 ${message.id ?? ''} 缺少原始时间，未伪造时间戳`);
      else {
        const zone = timestamps.timeZone || timeZone;
        const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time);
        next = { ...message, leaseWrxTimestamp: true, content: [{ type: 'text', text: `【消息时间：${clock}（${zone}）】\n` }, ...(message.content ?? [])] };
      }
    }
    if (['system', 'developer'].includes(message.role)) {
      if (started) {
        if (midConversationSystem === 'user') next = { ...next, role: 'user' };
        else warnings.push('包含历史中间的 system/developer 消息；pi-ai 默认可能将其合并到开头，需核验供应商最终序列化或显式启用 user 兼容策略');
      }
    } else started = true;
    return next;
  });
  if (midConversationSystem === 'user' && presented.some((message, index) => message.role !== messages[index].role)) warnings.push('已将历史中间的 system/developer 转为 user 以保持传输顺序；角色优先级随之改变');
  return { messages: presented, warnings: [...new Set(warnings)] };
}
