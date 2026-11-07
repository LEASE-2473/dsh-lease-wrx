/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from './database.js';
import { nowIso } from './utilities.js';

export function beginColdDiaries(characterId, days, target = 'cold') {
  const d = openDb();
  const keep = Math.max(0, Number(days) || 0);
  const cutoff = new Date(Date.now() - keep * 86400000).toISOString().slice(0, 10);
  // 目标 freeze：直接冻住，不向量化（冻结不召回，省一次 embedding）。
  // 目标 cold：先标 pending，等向量补上再落 cold。
  if (target === 'freeze') {
    const info = d
      .prepare("UPDATE diaries SET injection_mode='freeze', updated_at=? WHERE character_id=? AND diary_date < ? AND injection_mode='hot'")
      .run(nowIso(), characterId, cutoff);
    return { frozen: info.changes || 0, pending: 0 };
  }
  const info = d
    .prepare("UPDATE diaries SET injection_mode='pending', updated_at=? WHERE character_id=? AND diary_date < ? AND injection_mode='hot'")
    .run(nowIso(), characterId, cutoff);
  return { frozen: 0, pending: info.changes || 0 };
}

export function beginColdActivities(characterId, days, target = 'cold') {
  const d = openDb();
  const keep = Math.max(0, Number(days) || 0);
  const cutoff = new Date(Date.now() - keep * 86400000).toISOString();
  if (target === 'freeze') {
    const info = d
      .prepare("UPDATE ai_notes SET injection_mode='freeze', updated_at=? WHERE character_id=? AND COALESCE(occurred_at, created_at) < ? AND injection_mode='hot'")
      .run(nowIso(), characterId, cutoff);
    return { frozen: info.changes || 0, pending: 0 };
  }
  const info = d
    .prepare("UPDATE ai_notes SET injection_mode='pending', updated_at=? WHERE character_id=? AND COALESCE(occurred_at, created_at) < ? AND injection_mode='hot'")
    .run(nowIso(), characterId, cutoff);
  return { frozen: 0, pending: info.changes || 0 };
}

/** 已经拿到向量的 pending 落成 cold。返回落了几条。 */
export function finishColdDiaries(characterId) {
  const d = openDb();
  const info = d
    .prepare("UPDATE diaries SET injection_mode='cold', updated_at=? WHERE character_id=? AND injection_mode='pending' AND vector IS NOT NULL")
    .run(nowIso(), characterId);
  return info.changes || 0;
}

export function finishColdActivities(characterId) {
  const d = openDb();
  const info = d
    .prepare("UPDATE ai_notes SET injection_mode='cold', updated_at=? WHERE character_id=? AND injection_mode='pending' AND vector IS NOT NULL")
    .run(nowIso(), characterId);
  return info.changes || 0;
}

/** 卡在转冷中太久（向量化一直失败）的退回热，别让记录既注入不了也召不回。 */
export function revertStalePending(characterId, minutes = 60) {
  const d = openDb();
  const cutoff = new Date(Date.now() - Math.max(1, Number(minutes) || 60) * 60000).toISOString();
  const a = d
    .prepare("UPDATE diaries SET injection_mode='hot', updated_at=? WHERE character_id=? AND injection_mode='pending' AND updated_at < ?")
    .run(nowIso(), characterId, cutoff);
  const b = d
    .prepare("UPDATE ai_notes SET injection_mode='hot', updated_at=? WHERE character_id=? AND injection_mode='pending' AND updated_at < ?")
    .run(nowIso(), characterId, cutoff);
  return (a.changes || 0) + (b.changes || 0);
}

