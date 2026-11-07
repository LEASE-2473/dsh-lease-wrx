# 日记

repository.js 管日记保存、标签与任务记录；service.js 管读取对话、调用模型和落库；time.js 管时区日期范围；prompts/ 存放可直接编辑的 Markdown。

日记提示词位于本模块prompts目录，长材料经分段及每日合并生成结果，编排器只读取需要注入的日记正文。

## 即时日记

instant.js 对照只读 Companion app/memory/role.py 的 time_window、summarize_diary、generate 实现：选定日内 HH:MM 时间段，开始包含、结束不包含，结束可用24:00；调用 diaryInstant Markdown，溢出时递归分段再用 diaryMerge 合并，不截掉材料。严格验证正文、标题、标签和最多10条未结话题，最终一次事务新增 chat_entry，不替换每天总结或冻结原件。

管理页【日记】提供会话ID、起止时间、scope和生成按钮。POST /plugins/dsh-wrx-memory/api/diary/instant 请求：

```json
{"character":"default","sessionId":"会话ID","date":"2026-11-01","startTime":"10:00","endTime":"11:00","scope":"conversation"}
```

scope 默认为 conversation；character 跨该角色会话。DSH 流水通过 session_id 关联已有 conversations 表的 character_id，character 范围仅读取目标角色的已跟踪会话流水。按 session 固定 Preset、Preset 固定角色的约定使用，不保存逐条消息归属。非 DSH 会话则验证角色归属。即时生成使用已有本地流水；不在请求期间读取在线私人会话或补历史。

返回 status 为 done / empty / already_processed，record_ids 为保存的日记ID。材料、时间段、scope哈希去重，运行/完成任务不重复生成，失败可重试；崩溃后超过1小时无进展的运行任务可重新领取。任务状态保存在 diary_instant_jobs，日记和成功任务在同一事务保存。调用最多64次，最小片段仍超限或合并不收敛则报错，不留下部分日记。

提示词每次调用即时读文件，可通过原有提示词覆盖机制编辑；未移植 Companion 的独立模型usage审计及取消API。已有后台模型适配负责单次180秒超时。测试 node --test tests/instant-diary.test.mjs 覆盖边界、scope、去重、冻结保护、坏输出回滚、超限分段/合并及API实际保存。
