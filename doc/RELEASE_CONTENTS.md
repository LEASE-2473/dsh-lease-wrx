# 发行源码功能清单

发行依据是项目源码工作区，不是某台机器上安装插件的文件树。`npm pack`会包含尚未提交的工作区文件；GitHub使用者只有在相应提交推送后才能取得这些改动。

| 功能 | 项目中的实现 |
| --- | --- |
| 默认数据与安装目录分离 | app/common/paths.js、config.js |
| 用户提示词三层读取、保存只写运行目录 | app/memory/common/prompt_files.js；用户稿prompts/active、用户默认prompts/defaults、安装默认defaults/prompts |
| 消息时间仅到秒、不附时区文字，仅标记真实用户 | app/integrations/dsh/request-presentation.js |
| 画像输入输出不按字数/条数静默裁剪，失败保留原件 | app/profile/user/service.js、assistant/service.js、app/providers/llm.js |
| 画像覆盖前备份，保留14天并由心跳清理 | app/profile/documents.js、app/memory/scheduler.js |
| 四表、活动、检索、技能草案及向量文本完整正文 | app/memory、app/skills/service.js、app/integrations/dsh/tools.js |
| 全文按钮定位已有条目，不重复添加 | app/preset/ui/editor.js |
| 会话工作目录宏dsh.cwd | app/prompting/macros/index.js、app/integrations/dsh/request-hook.js |
| 新旧宿主请求边界、目录变更记录读取和幂等升级 | app/integrations/dsh/patches/request-hook.js、scripts/install-request-hook.mjs |
| OpenCode Go中间system能力及分离目录检测 | app/integrations/dsh/compat.js、patches/pi-ai-system-capability.js、scripts/install-pi-ai-capability.mjs |

## 安装者自己的配置

以下内容不是通用程序源码，不能从个人运行目录直接复制进发行包：

- 角色、个人预设及排列、画像、记忆、游戏存档、凭证和模型账号。
- 使用者自行创建的DSH Agent Preset、项目AGENTS.md及skills。需要原生组件的配置示例见[安装说明](INSTALL.md)。
- DSH主程序的已修改二进制依赖文件：发行包携带的是可检查、显式应用的补丁生成器和安装脚本，而不是某台机器的node_modules。

技能目录保持DSH原生user消息的初期发布/变化更新方式，不提供已撤回的固定段目录宏。

## 日记实现边界

当前日记实现仍是超过输入门限后分段生成，再合并结果；没有丢弃发言尾部。逐批带着已经写出的正文继续续写，是另一项尚未完成的需求，不能把现有“分段后合并”表述为已实现该需求。

## 发行检查

运行源码检查和本地回归，再使用`npm pack --ignore-scripts --json`检查实际归档。核对包中包含上述运行模块、defaults和两个安装脚本，不含data、个人预设、测试、连续性记录、凭证或备份。用户可编辑提示词保留通用默认稿，不从某台运行实例回灌。
