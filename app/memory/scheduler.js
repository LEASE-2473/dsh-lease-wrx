import { currentRole } from '../common/role-context.js';
import { listRoles, inRole } from '../common/roles.js';
/** 后台任务协调器，业务任务实现位于各自功能模块。 */
import { loadConfig } from '../common/config.js';
import { characters, hasDiary, listActivity, revertStalePending, beginColdDiaries, beginColdActivities, finishColdDiaries, finishColdActivities, getDiaryJob, recordDiaryAttempt, cleanupTempSummaries, pruneChatLog, listRows, setMode } from './db.js';
import { backfillVectors } from './recall.js';
import { summarizeRange, generateDiary, generateActivity } from './summarize.js';
import { runProfileJob, runSelfProfileJob } from './profile.js';
export function registerMemoryScheduler(ctx, { running = new Set(), timers = { setInterval, clearInterval } } = {}) {
  // 后台任务：总结 / 日记 / 外出报告，共用一个 60 秒心跳。
  ctx.effect(() => {
    const timezone = () => loadConfig().timezone || 'Asia/Shanghai';
    const localHour = (date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone(), hour: '2-digit', hour12: false }).format(date)) % 24;
    const localDate = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const yesterday = () => localDate(new Date(Date.now() - 86400000));

    const tickSummary = async (cfg) => {
      const intervalMs = Math.max(1, Number(cfg.summary.intervalMinutes) || 60) * 60000;
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        if (running.has(char.id)) continue;
        const end = Date.now() - (Date.now() % intervalMs);
        const from = end - intervalMs;
        if (end <= from) continue;
        running.add(char.id);
        try {
          await summarizeRange(ctx, { character: char.id, start: new Date(from).toISOString(), end: new Date(end).toISOString(), auto: true });
        } catch (error) {
          ctx.logger?.warn?.('[wrx-memory] 自动总结失败：' + (error?.message || error));
        } finally {
          running.delete(char.id);
        }
      }
    };

    const tickDiary = async (cfg) => {
      if (localHour(new Date()) !== Number(cfg.diary.hour ?? 3)) return;
      const day = yesterday();
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        const key = char.id + ':diary';
        if (running.has(key) || hasDiary(char.id, day)) continue;
        running.add(key);
        try {
          await generateDiary(ctx, { character: char.id, date: day });
          ctx.logger?.info?.('[wrx-memory] 已写日记：' + char.name + ' / ' + day);
        } catch (error) {
          ctx.logger?.warn?.('[wrx-memory] 自动日记失败：' + (error?.message || error));
        } finally {
          running.delete(key);
        }
      }
    };

    const tickActivity = async (cfg) => {
      if (localHour(new Date()) !== Number(cfg.activity.hour ?? 10)) return;
      const today = localDate(new Date());
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        const key = char.id + ':activity';
        if (running.has(key)) continue;
        const recent = listActivity(char.id, 1)[0];
        if (recent && localDate(new Date(recent.occurred_at || recent.created_at)) === today) continue;
        running.add(key);
        try {
          await generateActivity(ctx, { character: char.id, hours: 24 });
          ctx.logger?.info?.('[wrx-memory] 已生成外出报告：' + char.name);
        } catch (error) {
          ctx.logger?.warn?.('[wrx-memory] 自动外出失败：' + (error?.message || error));
        } finally {
          running.delete(key);
        }
      }
    };

    const autoColdTimes = new Map();
    const tickAutoCold = async (cfg) => {
      const hours = Number(cfg.summary?.autoColdHours) || 3;
      const now = Date.now();
      const lastAutoColdAt = autoColdTimes.get(currentRole()?.id);
      if (!lastAutoColdAt) { autoColdTimes.set(currentRole()?.id, now); return; }
      if (now - lastAutoColdAt < hours * 3600 * 1000) return;
      autoColdTimes.set(currentRole()?.id, now);
      if (!loadConfig().vector.enabled) return;
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        const hot = listRows(char.id).filter((r) => r.mode !== 'cold');
        if (!hot.length) continue;
        // 先入向量再转冷；补向量失败就这批先不转，宁可热点也别丢记忆。
        try {
          await backfillVectors(char.id);
        } catch (error) {
          ctx.logger?.warn?.('[wrx-memory] 转冷前补向量失败，这批先不转：' + (error?.message || error));
          continue;
        }
        for (const r of hot) setMode(char.id, r.id, 'cold', { vectorEnabled: true });
        ctx.logger?.info?.('[wrx-memory] 自动转冷：' + char.name + ' ' + hot.length + ' 条（已向量化）');
      }
    };

    // 日记和外出记录到期转冷：超过注入窗口的记录标成 cold，一条都不删。
    // 冷 = 可向量召回，所以转之前必须先把向量补上；没向量的宁可不转，也不制造「记了却永远发不出去」的死记忆。
    // 每 6 小时跑一轮；lastStaleColdAt 初始为 0，所以启动后第一轮会先清一次积压。
    const staleColdTimes = new Map();
    const tickStaleCold = async (cfg) => {
      const now = Date.now();
      const everyMs = Math.max(1, Number(cfg.tavern?.coldCheckHours) || 6) * 3600 * 1000;
      const lastStaleColdAt = staleColdTimes.get(currentRole()?.id);
      if (lastStaleColdAt && now - lastStaleColdAt < everyMs) return;
      staleColdTimes.set(currentRole()?.id, now);
      if (!cfg.vector?.enabled) return;
      if (cfg.tavern?.coldEnabled === false) return;
      const diaryDays = Number(cfg.tavern?.diaryDays) || 2;
      const activityDays = Number(cfg.tavern?.activityDays) || 2;
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        try {
          // 1) 卡在转冷中太久的退回热，别让记录既注入不了也召不回。
          //    本轮退回过就不再重新开转冷，让它们先在热里待着，下一轮再试。
          const reverted = revertStalePending(char.id, 60);
          if (reverted) {
            ctx.logger?.info?.('[wrx-memory] 转冷超时退回热：' + reverted + ' 条（本轮不再重开转冷）');
            continue;
          }
          // 2) 到期：日记、外出各自按配置的归宿处理。freeze 直接冻住，cold 先标「转冷中」。
          const diaryTarget = cfg.tavern?.diaryColdTo === 'cold' ? 'cold' : 'freeze';
          const activityTarget = cfg.tavern?.activityColdTo === 'freeze' ? 'freeze' : 'cold';
          const beganD = beginColdDiaries(char.id, diaryDays, diaryTarget);
          const beganA = beginColdActivities(char.id, activityDays, activityTarget);
          const frozen = beganD.frozen + beganA.frozen;
          const queued = beganD.pending + beganA.pending;
          if (frozen) {
            ctx.logger?.info?.('[wrx-memory] 冻结：' + char.name + ' 日记 ' + beganD.frozen + ' 条、外出 ' + beganA.frozen + ' 条');
          }
          if (queued) {
            ctx.logger?.info?.('[wrx-memory] 开始转冷：' + char.name + ' 日记 ' + beganD.pending + ' 条、外出 ' + beganA.pending + ' 条');
          }
          // 3) 给转冷中的记录补向量。
          await backfillVectors(char.id);
          // 4) 有向量的才落成「冷」，也就是转冷完成。
          const coldD = finishColdDiaries(char.id);
          const coldA = finishColdActivities(char.id);
          if (coldD || coldA) {
            ctx.logger?.info?.('[wrx-memory] 转冷完成：' + char.name + ' 日记 ' + coldD + ' 条、外出 ' + coldA + ' 条');
          }
        } catch (error) {
          ctx.logger?.warn?.('[wrx-memory] 转冷流程失败，下一轮重试：' + (error?.message || error));
        }
      }
    };

    // 启动/心跳补写漏掉的日记：3 点那个窗口如果进程没开，昨天的日记就永远缺了。
    // 失败原因和尝试次数都落进 system_diary_jobs，别再只打一条看不到的 warning。
    const tickDiaryBackfill = async (cfg) => {
      if (!cfg.diary?.enabled) return;
      const days = Math.max(1, Number(cfg.diary.backfillDays) || 3);
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        for (let i = 1; i <= days; i += 1) {
          const day = localDate(new Date(Date.now() - i * 86400000));
          if (hasDiary(char.id, day)) continue;
          const key = char.id + ':diary-backfill:' + day;
          if (running.has(key)) continue;
          const previous = getDiaryJob(char.id, day);
          // 那天确定没有聊天原文的，记成 empty 就不再每分钟撞一次。
          if (previous && previous.status === 'empty') continue;
          // 失败限流可配：开发阶段把 retryCooldownMinutes 设 0 就不拦，生产再加冷却。
          const cooldownMinutes = Number(cfg.diary?.retryCooldownMinutes ?? 360);
          if (cooldownMinutes > 0 && previous && previous.status === 'error' && Number(previous.attempts) >= 3
            && Date.now() - new Date(previous.updated_at).getTime() < cooldownMinutes * 60000) continue;
          running.add(key);
          try {
            const out = await generateDiary(ctx, { character: char.id, date: day });
            recordDiaryAttempt(char.id, day, 'done');
            ctx.logger?.info?.('[wrx-memory] 补写日记：' + char.name + ' / ' + day + ' / ' + (out.title || ''));
          } catch (error) {
            const message = String(error?.message || error);
            // 当天没有聊天原文不算故障：记 empty，之后不再重试。
            const empty = message.includes('没有对话');
            recordDiaryAttempt(char.id, day, empty ? 'empty' : 'error', message);
            ctx.logger?.warn?.('[wrx-memory] 补写日记失败 ' + day + '：' + message);
          } finally {
            running.delete(key);
          }
        }
      }
    };

    // 每天一次用户画像：只吃用户本人的发言，审聊天模型提交的候选，写回 global_user_profile。
    // 定时放在 config.profile.hour（默认 4 点）；同一天成功过就跳过，失败 6 小时内不重试。
    const tickProfile = async (cfg) => {
      if (cfg.profile?.enabled === false) return;
      const hour = Number(cfg.profile?.hour ?? 4);
      const tz = cfg.timezone || 'Asia/Shanghai';
      let localHour = 0;
      try {
        localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
      } catch { localHour = new Date().getHours(); }
      if (localHour < hour) return;
      const result = await runProfileJob(ctx, {});
      if (!result.skipped) ctx.logger?.info?.('[wrx-memory] 用户画像：' + JSON.stringify(result));
    };

    // 每天一次角色画像：从最近一天的原始对话重新总结「我自己」，写回 self_profile。
    // 跟用户画像错开时间（默认 5 点），两边不共用一份提示词（2026-10-26 加）。
    const tickSelfProfile = async (cfg) => {
      if (cfg.selfProfile?.enabled === false) return;
      const hour = Number(cfg.selfProfile?.hour ?? 5);
      const tz = cfg.timezone || 'Asia/Shanghai';
      let localHour = 0;
      try {
        localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
      } catch { localHour = new Date().getHours(); }
      if (localHour < hour) return;
      const result = await runSelfProfileJob(ctx, {});
      if (!result.skipped) ctx.logger?.info?.('[wrx-memory] 角色画像：' + JSON.stringify(result));
    };

    const tickVectors = async (cfg) => {
      if (!cfg.vector?.enabled) return;
      const targets = listRoles().filter(c => c.id !== 'default' && c.enabled && (!currentRole() || c.id === currentRole().id));
      for (const char of targets) {
        const result = await backfillVectors(char.id, { limit: 64 });
        if (result.done) ctx.logger?.info?.('[wrx-memory] 补向量：' + char.name + ' 新补 ' + result.done + ' 条，剩 ' + result.left);
      }
    };

    const tick = async () => {
      const globalConfig = loadConfig();
      if (globalConfig.profile?.enabled !== false) {
        try { await tickProfile(globalConfig); } catch (error) { ctx.logger?.warn?.('[wrx-memory] 用户画像：' + error.message); }
      }
      for (const role of listRoles().filter(role => role.enabled)) await inRole(role.id, async () => {
      const cfg = loadConfig();
      if (cfg.summary.enabled) {
        try { await tickSummary(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickSummary: ' + error?.message); }
      }
      if (cfg.diary.enabled) {
        try { await tickDiary(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickDiary: ' + error?.message); }
        try { await tickDiaryBackfill(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickDiaryBackfill: ' + error?.message); }
      }
      if (cfg.activity.enabled) {
        try { await tickActivity(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickActivity: ' + error?.message); }
      }
      if (cfg.selfProfile?.enabled !== false) {
        try { await tickSelfProfile(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickSelfProfile: ' + error?.message); }
      }
      if (cfg.summary.autoColdEnabled) {
        try { await tickAutoCold(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickAutoCold: ' + error?.message); }
      }
      try { await tickStaleCold(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickStaleCold: ' + error?.message); }
      if (cfg.vector?.enabled) {
        try { await tickVectors(cfg); } catch (error) { ctx.logger?.warn?.('[wrx-memory] tickVectors: ' + error?.message); }
      }
      });
      try { cleanupTempSummaries(7); } catch (error) { ctx.logger?.warn?.('[wrx-memory] 清理临时总结失败：' + (error?.message || error)); }
      try {
        const keepDays = Number(globalConfig.chatLog?.keepDays) || 90;
        const pruned = pruneChatLog(keepDays);
        if (pruned) ctx.logger?.info?.('[wrx-memory] 对话流水清掉 ' + pruned + ' 条（保留 ' + keepDays + ' 天）');
      } catch (error) { ctx.logger?.warn?.('[wrx-memory] 清理对话流水失败：' + (error?.message || error)); }
    };
    const timer = timers.setInterval(() => tick().catch(() => {}), 60000);
    ctx.effect(() => () => timers.clearInterval(timer), 'wrx-memory: scheduler timer');
    return () => timers.clearInterval(timer);
  }, 'wrx-memory: scheduler');

}
