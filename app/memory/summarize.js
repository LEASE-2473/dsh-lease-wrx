/** 后台总结、日记和自主活动服务的统一导出。 */
export { extractJson } from './common/generation.js';
export { runBatch, summarizeRange } from './system_memory/service.js';
export { dayRange } from './diaries/time.js';
export { generateDiary } from './diaries/service.js';
export { generateActivity } from './ai_notes/service.js';
