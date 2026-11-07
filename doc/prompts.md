# 后台提示词管理

后台任务与技能实际使用的正文来自 app 对应功能模块的 prompts/*.md。JS 通过 app/memory/common/prompt_files.js 的相对路径白名单读取，每次任务读取配置时重新加载；页面保存也写入同一个 Markdown 文件。JSON API 返回的 prompts 仅是读写传输对象，不保存到 data/config.json。

defaults/prompts/ 按同一相对目录保存15份独立默认稿，包含通用后台任务协议及整理指令。页面不能改写默认目录。GET /prompts/defaults 只读默认稿；POST /prompts/reset 读取默认稿并立即覆盖 app Markdown，刷新页面仍保持恢复结果。全部15份后台提示词均可在设置页编辑，包括角色画像、即时日记与分段合并指令。

| 功能 | 相对于 app 的目录或文件 |
| --- | --- |
| 四表提取、更新、总结合并 | memory/system_memory/prompts/{system,system_update,merge}.md |
| 每日日记、即时日记、即时合并 | memory/diaries/prompts/{diary,diary_instant,diary_merge}.md |
| 长日记分段、每日合并 | memory/diaries/prompts/{segment,daily_merge}.md |
| 外出记录 | memory/ai_notes/prompts/activity.md |
| 用户画像、角色画像 | profile/{user,assistant}/prompts/profile_summary.md |
| 技能 | skills/prompts/{persona,user,memory,preset}.md |

doc/active-prompts.json记录路径及默认稿哈希；校验默认稿与模块清单，不存储正文。修改默认稿时同步defaultSha256。LEASE_WRX_PROMPT_ROOT允许指定隔离模块根目录。

主聊天预设由app/preset管理，与后台Markdown系统提示词分开。发行预设库为空，不提供私人模板或资料。运行配置仅引用模块正文，不在config.json保存提示词正文副本。

## 输出协议与验证范围

四表第一阶段输出四表 JSON，若需读取冷记录，再追加唯一 recall_system_memory app_call；只可请求目录内一致的 id/name。第二阶段只返回 optimize_system_memory app_call（people/items 的变化字段）或固定 unchanged 调用“无新增”。不能仅修改提示词为其他格式而期待后端自动适配。非法输出会报错，两个阶段的四表更新在最终验证后同事务提交，第二阶段失败不残留第一阶段结果。

tests/prompt-contract-flow.test.mjs 从实际 system.md、system_update.md 抽取示例，用模拟模型回复驱动真实两阶段服务、冷记录查询与落库；原协议和并发测试另覆盖非法输出、无变化与回滚。tests/prompt-settings.browser.mjs 用真实页面及真实插件API验证15份编辑、保存、恢复、刷新和默认稿不变。模型响应为受控样例，不代表远端模型永远遵守协议；尚未在日常DSH实例做真实供应商全流程验收。
