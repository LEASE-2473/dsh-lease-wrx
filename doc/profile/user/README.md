# 用户资料

information.json 保存手写称呼和核心信息，profile.json 保存自动整理的 entries 与 revision，位于 data/profile/user/。repository.js 返回兼容现有 UI 的合并对象；candidates.js 管候选；service.js 管每日画像任务；prompts/ 存 Companion 默认及旧 DSH 提示词。

旧 SQLite 资料只作为兼容读取来源，读取不会自动迁移或改写。用户明确保存后使用新 JSON；后台画像任务保持已有 name/core，不把模型输出当作手写信息更新。
