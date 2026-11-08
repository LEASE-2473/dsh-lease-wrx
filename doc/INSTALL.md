# 安装与宿主接入

LEASE-WRX通过DSH的插件/profile机制加载，包名为dsh-wrx-memory。安装及更新由宿主插件管理流程负责，本项目不提供独立更新器、目录替换、备份或回滚工具。

## 发行内容

- app：WRX运行模块、管理界面、原生工具和宿主接入。
- defaults：空预设库及通用后台系统提示词。
- scripts/install-request-hook.mjs、scripts/install-pi-ai-capability.mjs：WRX宿主适配的显式应用入口。
- cordis.patch.yml、package.json：DSH插件声明。
- README与doc：当前产品说明。

首次加载时按需建立运行数据库。预设库为空，角色与后台默认关闭；个人预设、persona/profile通过界面配置，不属于发行资产。

## 数据目录

运行配置、数据库、预设及日志统一使用以下优先级：

1. 启动环境变量 LEASE_WRX_DATA_DIR：用户显式指定的数据目录。
2. DSH_HOME/dsh-wrx-memory：DSH宿主下的默认数据目录，与插件安装目录分离。
3. 仅配置 LEASE_WRX_DSH_ROOT 时，使用该宿主目录下的 dsh-wrx-memory。
4. 未配置宿主目录的独立开发环境，使用插件目录下的 data。

环境变量需在启动DSH前设置，修改后重启生效。安装命令不提供目录选择提示。更改数据位置不会自动搬迁旧数据；新目录没有数据时按全新状态初始化，需要保留旧资料时自行迁移。

## 宿主请求接入

自定义后台提示词保存到运行目录prompts/active/，不会随插件重装覆盖。读取顺序为用户保存稿、运行目录prompts/defaults/默认稿、安装包defaults/prompts/默认稿；缺失时只补用户目录默认稿，不创建保存稿。旧版正文在插件app目录，升级前应将15份当前稿原样迁到active；禁止用默认稿或旧prompts其他稿替代。显式LEASE_WRX_PROMPT_ROOT仍优先。

完整上下文编排需要DSH在请求冻结前交给WRX处理。对应生成器在app/integrations/dsh/patches/request-hook.js，显式入口为：

```sh
node scripts/install-request-hook.mjs --file "/DSH目录/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js"
```

默认只检查匹配情况；停用宿主后加--apply应用。宿主版本锚点不匹配时不能使用该生成器，需先适配相应DSH版本。请求接入不提供另一套late排序或time功能，实际顺序和时间标签统一由WRX编排器处理。

生成器支持原来的 derivedMessages 入口及 DSH 0.2.1-rc.5 的 boundaryMessages 入口。安装或升级 DSH 后应重新检查接入；仅安装 WRX、开启角色或成功预览，不代表宿主实际请求已接入。状态中的 hookRegistered 表示插件函数已注册，hookObserved 才表示已收到启用角色的请求。应用后重启 DSH，在已绑定角色的 Agent Preset 下发送一次新输入，再检查原生分块与最近编排记录。

## 供应商能力

OpenCode Go中间system兼容由WRX兼容性页管理。优先沿当前DSH CLI入口定位主程序安装包；主程序安装目录与DSH_HOME可以分离。旧布局仍支持DSH_HOME或LEASE_WRX_DSH_ROOT及profile依赖目录。不硬编码个人安装路径。DSH适配器需要显式开放该配置时，使用scripts/install-pi-ai-capability.mjs；这是WRX的模型协议接入，见[供应商兼容](integrations/dsh/PROVIDER_COMPATIBILITY.md)。

## 自定义DSH Agent Preset的项目文件能力

WRX不会修改使用者的DSH Agent Preset。自定义聊天模式若需要读取项目指令或技能，应在该模式的plugins中保留相应原生组件：

```yaml
plugins:
  - id: agent-instructions
    name: '@deepseek-ai/dsh-agent-instructions'
    config:
      maxBytes: 9007199254740991
      maxSourceBytes: 9007199254740991
  - id: skill-filesystem
    name: '@deepseek-ai/dsh-skill-filesystem'
  - id: tool-skill
    name: '@deepseek-ai/dsh-tool-skill'
```

上述指令读取预算用于避免宿主本地按字节裁剪，不能扩大供应商的上下文容量。标准模式已有的组件不要重复添加。项目AGENTS.md/CLAUDE.md的范围取决于会话工作目录；项目技能默认放在项目根目录的.dsh/skills或.agents/skills，而不是普通skills目录。技能目录是宿主单独发布的skill-catalog消息，和WRX的dsh.skills提示词分块不是同一个来源。

WRX提供文本宏`{{dsh.cwd}}`，只输出当前会话工作目录，可在自定义条目中写“当前项目目录：{{dsh.cwd}}”，自行安排位置；无需插入含时间和其他环境信息的整包dsh.runtime。用户自己的Agent Preset、目录绑定和预设正文不属于发行默认配置。

## 使用

在DSH设置中打开WRX，创建或导入个人预设，配置角色，绑定Agent Preset及独占WRX预设，再启用所需功能。记忆按角色隔离，用户资料全局共享。抓包入口在预设页，默认关闭，仅记录适配器输入。

## 排除模型切换通知（0.1.1）

在“预设与上下文编排 → 请求编排”勾选“排除模型切换通知”，点击“保存当前角色的启用与历史设置”。需要开启统一编排；每个角色独立保存，默认不勾选。预览使用当前勾选状态，新输入开始应用保存值，工具续轮保持本轮快照。

该选项仅从发给模型的请求中移除 source.kind=model-selection 的通知，覆盖历史通知和本轮追加通知；不删除会话记录、不影响实际模型选择，也不按正文关键词删除真人消息。安装后需重启DSH并刷新页面。
