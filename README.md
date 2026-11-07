# LEASE-WRX

DSH 的多角色记忆与上下文编排插件。提供四表长期记忆、日记、自主活动记录、用户与角色画像、预设编辑、历史窗口、原生工具和请求抓包。

发行版不附带主聊天预设、用户资料、persona 或 profile。首次安装预设库为空，角色和后台任务默认关闭。个人模板通过界面新建或导入附件，运行数据保存在 data；这些内容不进入 Git 或发行包。

## 功能边界

- WRX负责记忆、资料、提示词编排与自己的工具；DSH负责Agent循环、模型调用及工具执行。
- integrations/dsh是宿主接入层，不是额外插件。包括原生工具注册、抓包、宿主内容读取及请求接入。
- 上下文顺序与时间标签由编排器处理，不安装独立late/time补丁。
- DSH的请求冻结边界仍需要WRX请求适配器；它将请求交给编排器，不再维护另一套排序逻辑。
- OpenCode Go中间system消息兼容由WRX提供。请求适配与供应商兼容属于两个不同层次，详见[宿主接入](doc/integrations/dsh/README.md)。
- 不集成第三方网站、其他插件的专用工具或凭证读取。外部工具由用户或对应插件注册，需要留存经历时调用WRX的自主活动记录工具。

## 开发

Node >=22.16.0，JavaScript ESM，无前端构建步骤。

```sh
npm run init:data
npm test
npm run check
npm pack --dry-run --ignore-scripts --json
```

tests与中文开发连续性记录仅在本地保留，不纳入Git提交或发行包；上面的npm test用于持有本地测试目录的开发环境。测试使用临时数据和模拟模型。真实DSH适配测试须显式提供LEASE_WRX_DSH_ROOT，未提供时跳过，不搜索本机其他目录。浏览器测试配置PLAYWRIGHT_PATH与EDGE_PATH后运行tests/preset-ui.browser.mjs及tests/multi-role.browser.mjs。

本仓库只维护WRX插件，由DSH插件/profile机制负责安装与更新，不附带独立更新器或个人部署工具。接入要求见[安装与宿主接入](doc/INSTALL.md)，项目结构见[架构说明](doc/architecture.md)。

## 使用

在DSH插件/profile中加载dsh-wrx-memory后，进入设置中的WRX页面。新建或导入WRX预设，在角色看板绑定DSH Agent Preset及独占WRX预设，再启用角色。Default与未绑定会话使用原生DSH。角色之间隔离记忆和画像，用户资料全局共享。

抓包入口位于预设页，默认关闭。抓取模型适配器输入，包含messages与tools，可查看/导出/清空；不是供应商最终HTTP原文。数据仅保存在内存中。

- [预设与编排](doc/preset/README.md)
- [后台提示词](doc/prompts.md)
- [原生工具与宿主接入](doc/integrations/dsh/README.md)
- [供应商兼容](doc/integrations/dsh/PROVIDER_COMPATIBILITY.md)

当前包名dsh-wrx-memory，版本0.1.0，许可UNLICENSED。本地PROJECT_CONTEXT.md与CODEX_CHANGELOG.md用于中文开发连续性，不纳入Git提交或发行包。
