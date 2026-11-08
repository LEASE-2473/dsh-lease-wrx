# 供应商消息兼容

WRX编排顺序与模型适配器最终序列化是两个层次。适配器可能将对话中间的system折叠到开头；仅检查编排预览不能证明最终HTTP正文的位置。

## OpenCode Go

app/integrations/dsh/compat.js提供管理页的检查和应用能力，定位opencode-go catalog中的chat:deepseek-v4.1-flash、chat:deepseek-v4-pro，将supportsMidConvoSystemMessages设为true。只修改已存在的目标项，不创建模型或读取凭证。未找到相应模型时显示missing。

此功能属于WRX，不需要额外本机补丁插件。模型catalog升级后应重新检查。它不保证远端供应商一定支持中间system，也不代表已测量缓存命中。

主程序与用户目录分离时，兼容检测优先沿当前CLI入口识别实际DSH安装包。应用catalog修改前保存原件。若profile对模型另有显式配置，可以在对应模型的compat下设置`supportsMidConvoSystemMessages: true`；这需要下面的适配器配置能力已开放。只对实际支持的模型开启，不给所有供应商默认启用。

## DSH适配器能力开放

若DSH将该能力标为withhold，scripts/install-pi-ai-capability.mjs可显式开放配置入口：

```sh
node scripts/install-pi-ai-capability.mjs --file "/DSH目录/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"
```

默认只检查；停止宿主后加--apply写入。生成器位于app/integrations/dsh/patches/pi-ai-system-capability.js，仅开放supportsMidConvoSystemMessages，不自动启用其他能力。锚点不匹配时拒绝写入，重复执行幂等。

## 时间与验证

时间标签是request-presentation.js提供的原生功能，默认关闭，只标记有原始事件时间的真实用户消息；不会改写数据库或宿主历史。无需额外time补丁。

prompting.midConversationSystem默认preserve，保留消息角色；界面也提供明确的user降级策略，但改变角色不等于保留相同语义。

tests/dsh/provider-wire.test.mjs可在显式指定LEASE_WRX_DSH_ROOT后，加载实际DSH/pi-ai适配器向本机模拟HTTP服务验证最终正文、角色、tools及工具回放；不指定安装目录时跳过，不访问供应商。远端接受情况与缓存需在对应环境另行验收。
