# 角色资料

information.js 管稳定名字与角色定义；repository.js 管仅包含 entries/revision 的动态画像；service.js 根据近期聊天自动更新画像。动态条目使用 tag/keywords/content，可自然保存有依据的偏好或观点。独立看法表、工具、候选提醒与匹配来源已删除。

信息和画像分别保存在 data/profile/assistant/<编码角色ID>/information.json 与 profile.json。画像接口不再读写 name/identity，保存画像不改变稳定资料。关键词仅保留在条目中，未新增角色画像匹配功能。JSON 读取错误明确抛出，不静默重置文件；旧私人数据留到另行重装阶段处理。
