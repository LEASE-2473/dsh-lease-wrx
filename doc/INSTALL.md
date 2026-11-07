# 安装与宿主接入

LEASE-WRX通过DSH的插件/profile机制加载，包名为dsh-wrx-memory。安装及更新由宿主插件管理流程负责，本项目不提供独立更新器、目录替换、备份或回滚工具。

## 发行内容

- app：WRX运行模块、管理界面、原生工具和宿主接入。
- defaults：空预设库及通用后台系统提示词。
- scripts/install-request-hook.mjs、scripts/install-pi-ai-capability.mjs：WRX宿主适配的显式应用入口。
- cordis.patch.yml、package.json：DSH插件声明。
- README与doc：当前产品说明。

首次加载时按需建立运行数据库。预设库为空，角色与后台默认关闭；个人预设、persona/profile通过界面配置，不属于发行资产。

## 宿主请求接入

完整上下文编排需要DSH在请求冻结前交给WRX处理。对应生成器在app/integrations/dsh/patches/request-hook.js，显式入口为：

```sh
node scripts/install-request-hook.mjs --file "/DSH目录/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js"
```

默认只检查匹配情况；停用宿主后加--apply应用。宿主版本锚点不匹配时不能使用该生成器，需先适配相应DSH版本。请求接入不提供另一套late排序或time功能，实际顺序和时间标签统一由WRX编排器处理。

## 供应商能力

OpenCode Go中间system兼容由WRX兼容性页管理。宿主目录来自DSH_HOME；独立测试或特殊布局可显式设置LEASE_WRX_DSH_ROOT。未配置时显示未找到宿主，不猜测个人安装路径。DSH适配器需要显式开放该配置时，使用scripts/install-pi-ai-capability.mjs；这是WRX的模型协议接入，见[供应商兼容](integrations/dsh/PROVIDER_COMPATIBILITY.md)。

## 使用

在DSH设置中打开WRX，创建或导入个人预设，配置角色，绑定Agent Preset及独占WRX预设，再启用所需功能。记忆按角色隔离，用户资料全局共享。抓包入口在预设页，默认关闭，仅记录适配器输入。
