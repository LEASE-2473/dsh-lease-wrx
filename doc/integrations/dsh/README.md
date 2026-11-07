# WRX与DSH接入

app/integrations/dsh是WRX对宿主API的接入层，不安装第二个插件，不依赖其他第三方插件。

| 文件 | 职责 |
| --- | --- |
| client.js | 在DSH设置页注册WRX入口 |
| tools.js | 注册WRX原生工具并校验角色作用域 |
| source.js | 提供后台任务所需的角色对话素材 |
| preset-api.js | 读取宿主Agent Preset |
| request-hook.js | 注册WRX编排器并提供预览/状态 |
| request-presentation.js | 编排后呈现时间标签及消息角色策略 |
| capture.js | 默认关闭的内存请求抓包 |
| compat.js | OpenCode Go模型catalog的中间system能力配置 |
| patches/request-hook.js | 生成DSH请求接入适配 |
| patches/pi-ai-system-capability.js | 为DSH模型适配器开放显式能力配置 |

## 原生工具

- wrx_memory_search：查询长期记忆。
- wrx_diary_write / wrx_diary_read：追加与读取日记。
- wrx_activity_add / wrx_activity_read：写入与读取自主活动记录。
- wrx_persona_read / wrx_persona_update：读取与更新角色资料。
- wrx_profile_candidate：提交用户画像候选。

这些工具由WRX直接注册；未启用WRX的角色及子会话不能执行。四表正式写入由后台总结管线负责。skills模块另提供persona、user、memory、preset四类草案/授权流程；它不是日记或自主活动工具的外部依赖。

外部浏览器、网站访问或专用插件工具由各自提供者注册。WRX只接受用户或Agent提交的活动记录，不读取其他插件的凭证，不捆绑第三方网站工具。

## 请求接入与供应商兼容

编排器决定内容顺序、宏、历史窗口、时间标签和回合快照。宿主请求适配器只在冻结前交接messages、工具元数据、角色Preset及压缩边界，然后接收编排结果；不实现额外late排序或修改宿主历史。直接在llm/stream修改请求无法替代这个接入点。

```sh
node scripts/install-request-hook.mjs --file "/DSH目录/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js"
```

默认只检查，确认版本匹配且DSH停止后加--apply写入。只支持干净宿主及当前WRX适配器，不为旧late/time版本维护迁移逻辑。宿主升级后重新检查。

OpenCode Go兼容解决模型适配器如何序列化中间system消息，不能替代宿主接入。管理页可检查、应用；其他供应商的显式能力开放见PROVIDER_COMPATIBILITY.md。不自动声称任意供应商均支持相同协议。

## 抓包

capture.js监听llm/stream，记录适配器输入messages与tools，最多8MiB，只保留最近一次。默认关闭，停止/清空立即生效，关闭进程不落盘。入口为预设页“打开请求抓包工具”。导出可能包含用户内容，按个人资料管理。
