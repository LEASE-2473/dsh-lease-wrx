# 目录与开发规范

按功能组织JavaScript ESM代码，使用DSH插件协议。

| 目录 | 职责 |
| --- | --- |
| app/memory/system_memory | 四表仓储、协议、总结、临时记忆、路由、prompts |
| app/memory/diaries | 日记仓储、生成、时间、路由、prompts |
| app/memory/ai_notes | 外出/AI笔记仓储、生成、路由、prompts |
| app/memory/common | 空库、共享流水、向量、状态与提示词文件读写 |
| app/profile/user、assistant | 分离的信息与画像 JSON、任务、路由、prompts |
| app/preset | 预设存储/校验、空发行库、管理 API 和独立编辑 UI |
| app/prompting | 纯编译器、宏、历史策略、动态快照和素材采样 |
| app/integrations/dsh | 宿主接入、请求钩子、工具、兼容与显式补丁 |
| app/providers | 后台模型、向量、重排服务 |
| app/skills | 草案、授权、采用与审计 |
| app/common | 配置、路径、HTTP 公共辅助 |
| app/static/settings | 角色与功能管理页；预设入口加载新编辑器 |
| scripts | 初始化、检查、显式宿主补丁工具 |
| doc | 按功能维护当前使用与开发说明 |
| data | 运行库、个人预设与资料JSON；运行时生成，不纳入发布或Git |

app/index.js负责宿主组装与路由分发。memory/db.js、summarize.js、profile.js分别统一导出仓储、后台生成与画像任务，业务实现写在所属功能模块；preset/service.js提供预设业务服务与资料宏格式化。

后台提示词的相对路径按功能模块组织，页面只读写运行数据目录prompts/active中的用户稿；没有用户稿时依次使用prompts/defaults和安装包defaults/prompts的默认稿。读取默认只补缺失的用户目录默认稿，保存才生成active稿，不改安装文件；不自动采用旧prompts其他路径或JSON正文。路径白名单位于app/memory/common/prompt_files.js。app/preset管理用户目录中的主聊天预设，app/prompting编排实际消息。用户/角色资料、画像及技能草案也都存运行数据目录；安装包仅提供代码和通用默认值。

编译器只处理传入快照，不访问数据库或模型；宿主依赖留在 integrations。工具调用和结果不可拆，新输入才刷新动态素材。结构化宏不能混作普通字符串。

资源根路径和数据目录由 common/paths.js 统一确定。数据目录优先使用 LEASE_WRX_DATA_DIR，否则使用 DSH_HOME/dsh-wrx-memory；仅配置 LEASE_WRX_DSH_ROOT 时使用该目录下的 dsh-wrx-memory，无宿主配置时回退插件目录下的 data。运行模块与开发初始化使用同一规则；发布白名单与新资源同步维护。个人预设与角色资料不作为源码或发行资产。根目录维护中文连续性文档，不在子目录重复创建。

宿主接入只依赖DSH原生服务；不包含其他插件的工具、凭证读取或个人部署脚本。请求接入与供应商能力配置是发行包维护的适配层，见integrations/dsh/README.md。
