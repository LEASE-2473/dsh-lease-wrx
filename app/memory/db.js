/** 记忆、画像及对话仓储的统一导出。 */
export { openDb, closeDb } from './common/database.js';
export { TABLES, FIELDS } from './system_memory/schema.js';
export { nowIso, toIso, uid, plainDialogue, parseJson } from './common/utilities.js';
export { characters, characterDoc, updateCharacterDoc } from '../profile/assistant/information.js';
export { conversations, readMessages } from './common/conversations.js';
export { listRows, counts, rowById, updateRow, insertRow, deleteRow, setMode, existingPayload, memoryIndex, queriedRecords, batchUpsert, batchFind, batches, latestProcessedEnd, applyFourTables, applyOptimizedRecords } from './system_memory/repository.js';
export { vectorText, rowsMissingVector, saveVector, rowsWithVector } from './common/vectors.js';
export { listDiary, saveDiary, hasDiary, recordDiaryAttempt, getDiaryJob, listDiaryJobs } from './diaries/repository.js';
export { listActivity, saveActivity } from './ai_notes/repository.js';
export { beginColdDiaries, beginColdActivities, finishColdDiaries, finishColdActivities, revertStalePending } from './common/lifecycle.js';
export { saveCandidate, listCandidates, reviewCandidates } from '../profile/user/candidates.js';
export { searchMemories } from './common/search.js';
export { readUser, writeUser } from '../profile/user/repository.js';
export { readSelf, writeSelf } from '../profile/assistant/repository.js';
export { saveTempSummary, listTempSummaries, markTempSummaries, cleanupTempSummaries } from './system_memory/temporary.js';
export { insertChatLog, readChatLog, readChatLogExcluding, latestChatLogAt, pruneChatLog, chatLogCount, readSharedChatWindow, recordSummaryCoverage } from './common/chat_log.js';
