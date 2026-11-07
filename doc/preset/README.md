# 预设管理

app/preset负责集中预设存储、校验、编辑器及API；app/prompting负责实际消息编排，不在存储或页面复制编译规则。发行预设库为空。操作见[使用说明](使用说明.md)。

## 模块与数据

- store.js：读取data/presets/state.json；初始化文件data/presets.json与空发行库提供回退。保存只写集中state文件。
- validation.js：验证唯一ID、名称、条目及排序，保留用户正文与扩展字段；空预设库合法。
- routes.js：管理API、归属保护、并发基线合并及编排预览。
- ui：新建、复制、导入/导出、编辑、排序、温度、历史窗口及预览。
- defaults/presets.json：空库结构，不附模板或个人内容。

## 角色与保存

角色通过wrxPresetId独占引用预设。另一角色绑定的模板只读，复用时手动复制；名称原字符串完全相同拒绝。删除前须解除角色引用。

编辑器按管理角色的绑定项加载；选择预览项不改变角色绑定。保存发送变更ID、before/after基线及当前选择；服务端按项合并，不同项可并发，同项过期写入拒绝。角色启用、宿主Preset绑定及WRX引用在看板保存。

## 编排

按列表顺序展开条目；条目可选择宏来源、消息角色、启停或精确删除规则。工具schema始终由API tools发送，不靠正文目录替代。补齐常用内容只加入七个缺失来源，不自动保存或添加重复工具目录。

历史窗口支持当前会话最近N轮、跨会话滚动时长、跨会话固定起点。时间标签使用原始事件时间，策略在新输入时采样，工具续轮保持快照。详情见[编排规则](../prompting/README.md)。

## API

前缀/plugins/dsh-wrx-memory/api/preset。

- GET /state：读取state、归属及宏清单。
- PUT /state：提交changes:[{id,before,after}]与selectedPresetId，返回合并结果；管理角色下不接受缺少编辑基线的整库覆盖。
- POST /preview：预览未保存的state及输入/历史，不改运行模板。

宿主负责登录鉴权，模块负责角色归属和数据校验。预设页也提供原生抓包入口。
