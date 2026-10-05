# Browser Link 云端站点

私有 Sites 站点提供设备配对管理、MCP 工具和 D1 命令队列。站点使用 Sites 注入的用户身份；设备端还需平台服务访问凭据和独立配对密钥。

`npm test` 检查租户隔离、配对、去重、原子领取和 MCP 参数边界。`npm run build` 生成 Worker 与数据库迁移，`npm run validate` 检查部署产物。测试通过不等于生产通信验收。

MCP 创建任务返回 `session_id` 与 `command_id`，通过 `cloud_browser_result` 取回本机任务 ID，再执行 `new_tab` 和其他页面动作。云端接口不能访问本地 owner、文件路径、Cookie 镜像或原始脚本通道。

Sites 的插件由站点托管流程提供。使用它已有的私有插件，不另建 App，不用本地 MCP 注册替代云端连接。设备配对和原有网页审批分别生效。
