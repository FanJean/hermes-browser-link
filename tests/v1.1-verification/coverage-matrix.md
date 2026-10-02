# 离线回归清单

这些显式清单由 `scripts/verify-v1.1-offline.py` 维护，不启动真实浏览器；执行结果与环境限制另行记录。

## 核心 Node

- `bench/site/server.test.mjs`：本地站重定向、目录懒加载、第二主机查询、分页、multipart 提交与日志重置；不绑定 TCP 端口
- `bench/mechanical-metrics.test.mjs`：同站与四页机械指标的 N 轮样本、p50/p90 和失败样本排除
- `browser-workspaces/workspaces.test.mjs`：含 1.3.4 人工移交后保留标签组、旧工作区拒绝继续操作
- `tests/v1-launch-safety/launch-safety.test.mjs`
- `tests/v1.1-advanced/frame-catalog.test.mjs`
- `tests/v1.1-highlight-wiring/wiring.test.mjs`
- `tests/v1.1-concurrency/tab-barrier.test.mjs`
- `tests/v1.1-runtime-performance/cdp-budget.test.mjs`
- `tests/network-evidence/network.test.mjs`
- `tests/network-evidence/page-request.test.mjs`
- `tests/v1.1-packaging/directory-swap.test.mjs`
- `tests/v1.3/parser.test.mjs`
- `tests/v1.3/ledger.test.mjs`
- `tests/v1.1-interactions/test_inflight_guard.mjs`
- `tests/v1.1-semantics/enhancement.test.mjs`
- `tests/v1.1-overlay/background.test.mjs`
- `tests/v1.1-overlay/integration.test.mjs`
- `tests/v1.1-overlay/fail-closed.test.mjs`
- `tests/v1.1-ui/assets.test.mjs`
- `tests/v1.1-ui/background-integration.test.mjs`
- `tests/v1.1-ui/bridge-errors.test.mjs`
- `tests/v1.1-ui/notifier.test.mjs`
- `tests/v1.1-ui/overlay.test.mjs`
- `tests/v1.1-ui/page-settle.test.mjs`
- `tests/v1.1-ui/panel.test.mjs`
- `tests/v1.1-docs/check-bridge-docs.test.mjs`
- `executor-plugin/desktop/plugin.test.mjs`
- `executor-plugin/desktop/render.test.mjs`
- `tests/native-v2/native_core.test.mjs`
- `tests/native-extension/redirect-ready.test.mjs`：普通工作页 readyState、DOM 可交互返回、www 与跨站跳转
- `tests/popup-integration/popup.test.mjs`
- `tests/popup-integration/content-filter.test.mjs`
- `page-semantics/long-text.test.mjs`
- `page-semantics/controls.test.mjs`
- `tests/complex-ui/semantics.test.mjs`：重定位、Shadow/iframe、推断点击、组合框、富文本、虚拟列表、表格和 canvas
- `tests/native-extension/sensitive-fields.test.mjs`：普通字段误判与密码、卡号、验证码正例；旧版失败已复现。
- `tests/native-extension/bridge-cdp-errors.test.mjs`：扩展固定错误码及结果不确定语义。
- `tests/complex-ui/actions.test.mjs`：引用操作、受控输入读回、portal 选择计划和遮挡拒绝
- `executor-plugin/tests/test_result_privacy.py`：新增字段经公共工具投影到 Hermes，并过滤输入值、属性值和页面异常原文
- `native-bridge/tests/test_tasks.py`：daemon 错误摘要裁剪；涉及 socket 的集成用例需本机补跑
- `tests/v1.1-single-tools/test_adapter.py`：官方单工具保留 canvas 覆盖率、推断标记和重定位
- `tests/v1.1-script-lane/test_script_tool.py`：脚本子进程接收语义字段、重定位与脱敏错误摘要

## 补充验证

- `bench/test_compare.py`：机械与代理结果变化、退步方向、零基线及缺失生命周期指标显示
- `bench/agent/test_score.py`：表单、CSV、SPA、登录墙、同站八页、两站三轮评分；只读会话指标和 tasks.json 快照；三类重复打开原因
- `tests/v1.1-ui-acceptance/popup.test.mjs`
- `tests/v1.1-redaction-fix/redaction.test.mjs`

## 审阅后的跨模块验证

- `tests/v1.1-approval-notify/test_site_read.py`
- `tests/site-tools/test_sites.py`
- `tests/site-tools/test_reference_doctor.py`
- `tests/v1.3/test_script.py`
- `tests/v1.1-advanced/test_controls_validation.py`
- `tests/v1.1-advanced/pointer.test.mjs`
- `tests/v1.1-advanced/frame-catalog.test.mjs`
- `tests/v1.1-advanced/test_artifacts.py`
- `tests/v1.1-advanced/downloads.test.mjs`
- `tests/v1.1-advanced/test_downloads.py`
- `tests/v1.1-advanced/advanced.test.mjs`
- `tests/v1.1-advanced/test_advanced.py`
- `tests/v1.1-advanced/test_browser_exec.py`
- `tests/v1.1-advanced/test_vault_private.py`
- `tests/v1.1-advanced/vault.test.mjs`
- `tests/v1.1-advanced/test_vault_adapter.py`
- `tests/v1.1-build-closure/build-closure.test.mjs`
- `tests/v1.1-compatibility/test_inventory_official_browser.py`
- `tests/v1.1-concurrency/test_production_concurrency.py`
- `tests/v1.1-diagnostics/test_doctor_protocol.py`
- `tests/v1.1-diagnostics/test_task_diagnostics.py`
- `tests/v1.1-diagnostics-api/test_diagnostics_api.py`
- `tests/v1.1-diagnostics-daemon/test_diagnostics_daemon.py`
- `tests/v1.1-diagnostics-install/test_stage_diagnostics.py`
- `tests/v1.1-highlight/highlight.test.mjs`
- `tests/v1.1-highlight-integration/test_highlight_integration.mjs`
- `tests/v1.1-highlight-wiring/wiring.test.mjs`
- `tests/v1.1-integration-check/checker.test.mjs`
- `tests/v1.1-interactions/navigation.test.mjs`
- `tests/v1.1-packaging/test_release_closure.py`
- `tests/v1.1-redaction-lint/redaction-lint.test.mjs`
- `tests/v1.1-security-audit/approval-origin.test.mjs`
- `tests/v1.1-security-audit/test_security_boundary.py`
- `tests/v1.1-semantics-quality/semantics-quality.test.mjs`
- `tests/v1.1-single-tools/test_adapter.py`
- `tests/v1.1-single-tools/test_override_registration.py`
- `tests/v1.1-runtime-performance/test_runtime_connection_budget.py`
- `tests/v1.1-runtime-performance/test_journal_recovery.py`
- `tests/v1.1-ui-acceptance/approval-panel.test.mjs`
- `tests/v1.1-ui-acceptance/desktop.test.mjs`
- `tests/v1.1-ui-fixes/desktop-connection-state.test.mjs`
- `tests/v1.1-ui-fixes/desktop-initial-loading.test.mjs`
- `tests/v1.1-workspace-fix/cleanup-state.test.mjs`
- `tests/v1.1-workspace-recovery/recovery.test.mjs`
- `tests/v1.1-workspace-transient/workspace-transient.test.mjs`
- `tests/v1.1-highlight-review/review.test.mjs`
- `tests/v1.1-lint-scope/lint-scope.test.mjs`
- `tests/v1.1-access-review/test_access_request_timeout.py`
- `tests/v1.1-highlight-deadline/deadline.test.mjs`
- `tests/native-v2/native_core.test.mjs`：1.3.5 后台滚动短期限。
- `tests/v1.1-runtime-performance/test_journal_recovery.py`：动作超时后保留 ready、代次与标签租约。
- `tests/v1.1-advanced/advanced.test.mjs`：JS 语法错误和运行时异常的固定码。
- `tests/site-tools/test_reference_doctor.py`：单次探测超时返回未确认。
- `bench/agent/test_score.py`：真实 Hermes 元工具调用和回执包装格式。
- `tests/native-extension/file-upload-visual.test.mjs`：隐藏文件输入关联可见标签、可见输入保持原目标与无可见区域降级派发。
- `tests/complex-ui/actions.test.mjs`：视口外目标居中滚动、已可操作目标不滚动及固定浮层拒绝。
- `tests/v1.3.6/efficiency.test.mjs`：同任务建页并发、四页慢加载、`partial`、模型标签上限与选择器居中。
- `executor-plugin/tests/test_open_tool.py`：同站复用、新任务开关、失败后任务标识、摘要上限及摘要 ref 后续动作。
- `tests/v1.1-script-lane/test_action_session.py`：脚本导航摘要与原始绑定、快照引用。

- `tests/v1.3.6/test_concurrent_tabs.py` + `concurrent-extension.mjs`：真实 daemon/Bridge/Executor/NativeWorkspaces 管道，四页与八页并发、四页容量上限、创建顺序、回收通知先到、回执乱序、租约一致、冲突只拒绝单请求、代次/模式/来源限制、后续 tabs/navigate。
- `executor-plugin/tests/test_native_tools.py`：needs_sync/task_busy 中文提示和派发前后 outcome_unknown。
- `bench/mechanical-runner.test.mjs`：测量任务独立、失败不阻断下一项、准备失败和动作失败保留 bridgeCode 与诊断码。

## 1.4.0 改名与迁移

- `tests/v1.4/test_migration.py`：默认 dry-run、临时 HERMES_HOME 和浏览器目录、权限及 profile 配置保留、失败回滚、幂等、符号链接拒绝、套接字跳过、固定扩展来源。

## 1.4.1 接管、日志、主要链接与名称匹配

- `tests/v1.1-script-lane/test_action_session.py`：脚本暂停等待同一任务、恢复后继续、超时归类。
- `tests/v1.1-script-lane/test_page_helpers.py`：必填标记与空白规范化、最近三个候选。
- `tests/v1.1-ui/overlay.test.mjs`、`tests/v1.1-overlay/background.test.mjs`：快捷键路径、模拟鼠标坐标与开关、后台不画、接管和恢复。
- `tests/v1.4.1/test_features.py`：主要链接跨 profile 持久化、离线标记、任务日志脱敏与保留天数、恢复摘要字段限制、具体诊断错误码。
- `executor-plugin/tests/test_open_tool.py`：显式实例、主要链接、环境默认值、未连接回退优先级。
- `executor-plugin/desktop/plugin.test.mjs`、`executor-plugin/tests/test_native_tools.py`：桌面设置入口、工具只读等待与日志查询、模型无主要链接设置工具。
- `bench/mechanical.mjs`：新增 `takeover_resume`，真实浏览器阶段需与同机同浏览器基线比较。

## 1.4.2 真实表单与截图

- `tests/v1.4.2/forms.test.mjs`：隐藏 token 与可见密码字段矩形、封闭 Shadow Root 跨源框架遮罩、首屏外提交按钮与图片按钮、关联 label 命中及弹窗遮挡。
- `tests/v1.4.2/test_paths.py`：导出根、越界与软链接拒绝、共享 `.env`、名称后缀及可编辑目标筛选。
- `bench/site/server.test.mjs` 与 `/real-form-cases`：合成真实表单形态；`bench/mechanical.mjs` 增加普通与遮罩截图耗时项。

## 1.5.0 Cookie 镜像

- `tests/v1.5.0/cookie-mirror.test.mjs`：合成 cookies API，覆盖域聚合、分块、强制确认、逐条写入、回读、私有账本隔离及固定扩展身份。
- `tests/v1.5.0/test_cookie_mirror.py`：一次性内存中转、TTL、失败/断连清理、状态/日志/磁盘隐私，以及 daemon → client → 工具的计数与固定类别白名单。
- 两个 runner 纳入固定清单与发现核对；基准步骤 36，发现清单 82。`real-cookie-mirror.mjs` 和 `fixture-site.mjs` 仅用于手动真实验收，不由门禁启动。
