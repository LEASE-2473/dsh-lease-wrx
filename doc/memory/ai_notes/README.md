# 外出记录与 AI 笔记

repository.js 管记录读写；service.js 生成记录；prompts/ 保留 Companion 默认和旧 DSH 原文。Companion 输出的 content 字段和旧 DSH 的 note/activity_content 字段均可解析。

这个模块不会因为生成一篇记录就真的“出门”。自主工具执行和执行结果记录属于宿主能力；默认提示词要求区分工具确认事实和想法，不能把计划当完成事实。
