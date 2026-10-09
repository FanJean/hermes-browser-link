# 浏览器执行器基准

本目录固定测试站、机械动作和七个代理任务。测试数据是合成数据。`bench/mechanical.mjs` 和 `bench/agent/run.sh` 需要本机 Chrome/Edge 与 Hermes，未纳入离线自动运行。

## 本机运行

在仓库根目录开一个终端启动站点：

```bash
node bench/site/server.mjs 8765
```

另开终端运行机械基准。冷开页指已连接的临时浏览器的第一个任务，浏览器进程启动单独计为 `browser_launch`；热开页指同一临时浏览器的后续任务。

```bash
node bench/mechanical.mjs --browser chrome --reps 5 --label before --port 8765
node bench/mechanical.mjs --browser edge --reps 5 --label before-edge --port 8765
```

代理基准使用已安装且可用的 Hermes profile；`HERMES_BENCH_PROFILE` 默认为 `default`，可设为命名 profile。运行器逐个执行七个自包含任务，任务标题为 `基准·<任务名>·<label>`，会显示在侧栏。每项前清空站点日志，结束后保存快照、Hermes 文本输出、只读查询到的 session id 和当时 `tasks.json` 的只读副本。不要同时运行两份代理基准，共用站点日志会互相覆盖。

```bash
HERMES_BENCH_PROFILE=default bash bench/agent/run.sh before 8765
HERMES_BENCH_PROFILE=default python3 bench/agent/score.py "$(cat bench/results/agent-before-latest.txt)"
```

对比两轮同类 JSON：

```bash
python3 bench/compare.py bench/results/before-<时间戳>.json bench/results/after-<时间戳>.json
python3 bench/compare.py bench/results/agent-before-<评分时间戳>.json bench/results/agent-after-<评分时间戳>.json
```

离线验收：

```bash
node --test bench/site/server.test.mjs
python3 -m unittest discover -s bench -p 'test_compare.py' -v
python3 -m unittest discover -s bench/agent -p 'test_score.py' -v
python3 scripts/verify-v1.1-offline.py
npm run lint
npm run check:js
npm run check:docs
npm test
```

## 指标

机械基准每项保留每轮样本。成功率为通过动作回执及页面读回校验的次数除以尝试次数；p50/p90 用成功样本的 nearest-rank 分位数；max 为成功样本最大耗时。失败样本列错误码，不计入时延分位数。`same_site_navigate` 在原任务导航到 `/catalog`；`same_site_new_task` 建新任务并打开同站 `/catalog`。`four_pages_sequential` 在一个任务的一张标签里依次读四个 1.2 秒慢页；`four_pages_parallel` 在同一任务并行新建四张标签后读回。两组各运行 N 轮，输出 p50/p90。其余 `navigate`、快照、引用点击/填写、portal 下拉、文件上传、五页脚本采集、慢页、apex→www、iframe 与 shadow 点击均单独计时。慢页记录 `ready` 原值；开页记录诊断缓冲区中相应动作的七类阶段时长及 daemon `operationTimeline` 最后一项。拿不到时写“未拿到”，不推算。

提示词占用从插件 `_PROMPT` 默认系统提示片段、注册工具 schema 的当前源定义和三个插件 skill 文件统计字符数；粗估 token 为字符数除以四向上取整。`registeredToolCount` 不含可选 Vault 工具和获授权后接管的官方工具。skill 文件只有按需读取才进入模型上下文，因此总字符是可用内容规模，不等于首个模型请求的实际输入 token。

代理正确性以各任务日志及输出文件逐项打分：目录站六个文本字段、分类、订阅状态、两张文件的文件名与大小及一次提交；表格 CSV 表头、250 行逐行比较和五页请求；SPA 四个字段、结果点击及详情请求；弹窗关闭与主按钮点击顺序；登录墙无密码输入、无登录提交、Hermes 回复说明需要用户；产品目录八页共 32 个字段、请求覆盖；两站来回三轮结果和查询日志。登录页只记录密码字段是否变化，不记录内容。

代理效率从 所选 profile 的 `state.db`（默认 profile 在 `$HERMES_HOME/state.db`，命名 profile 在 `$HERMES_HOME/profiles/<profile>/state.db`） 以 SQLite `mode=ro` 读取：模型调用次数为 assistant 消息数；浏览器调用次数为 browser 前缀工具调用数；脚本调用数为 `browser_shared_script`；失败调用数按工具结果的结构化错误计。总耗时为 session 起止时间；浏览器耗时为 browser 工具调用消息到对应结果消息的时间差之和；模型思考耗时为浏览器结果到下一条发起浏览器调用的 assistant 消息时间差之和。输入 token 读 session 的 `input_tokens`。无字段或无法配对的值写“未拿到”。模型调用与思考时间是数据库消息级近似量，不包括无法单独观察的模型内部等待；工具结果如果只包含非结构化错误，失败数会偏低。

标签与任务指标也按会话消息顺序计算。`openCalls` 是 `browser_shared_open` 调用数；`repeatOpens` 是同一 URL origin 第二次及之后打开数。重复打开按该 origin 上次打开的返回判定：上次报错计 `repeatAfterError`；否则上次返回的 task_id 已被成功 `browser_shared_close` 关闭计 `repeatAfterClose`；其余计 `repeatWhileOpen`。这三类之和等于重复打开数。`newTasks` 是成功 open 返回的不同 task_id 数；`reusedOpens` 只在返回明确带 `reused: true` 时计数，无此字段记 0。`navigateExisting` 计 `browser_shared_run(action=navigate)`、`browser_navigate` 和脚本中的 `goto_url(` 调用点；`newTabs` 计 `browser_shared_run(action=new_tab)` 和脚本中的 `new_tab(` 调用点。脚本指标由传入代码静态计数，循环次数和失败的脚本内部动作无法从会话记录精确还原。

`maxConcurrentTabs` 从 open 返回的 tab_id，以及 `browser_shared_get`、`browser_shared_run(action=tabs/new_tab)` 返回的标签集合还原；没有标签证据写“未拿到”。`remainingTasks`/`remainingTabs` 使用每项运行结束时只读复制的 `$HOME/.hermes/plugin-data/browser-link-native/tasks.json`，只统计该会话成功 open 返回的 task_id 中尚未关闭的任务及其 `workTabs`。`handedToUserTasks`/`handedToUserTabs` 单列 `cleanupReason=handed_to_user` 的任务及标签；不并入未关闭任务。缺少快照时四项均写“未拿到”。对比表列出这些指标；缺失值不计算变化量。

## 局限

`takeover_resume` 在扩展中接管并恢复同一脚本进程。性能比较需在同一机器、浏览器与负载下先记录基线，再对比修改版本；不得用离线合成时延替代真实浏览器结果。

- 机械基准使用临时浏览器 profile 和源码扩展，代理基准使用 Hermes 当前 profile；两者不能直接比较绝对时延。
- 本地站模拟网络等待和复杂控件，不代表外部站点的真实延迟、验证码或登录策略。
- `operationTimeline` 只保留最近 32 条。机械脚本在开页后立即读取。诊断缓冲区是有界的，事件缺失时不填估计值。
- 代理任务需要固定标签、端口、浏览器和机器负载；跨机器结果仅供参考。对比脚本对低耗时/少调用判为改善，对正确率判为高分改善；正确率下降标为退步。
- `tasks.json` 是结束时快照，不含会话中的每一步标签变化。脚本里的多次动态导航只能按代码调用点计数。两个站使用 `www.bench.localhost` 与 `tools.localhost`；机械站点服务器仅监听 `127.0.0.1`。

## 1.4.2 截图基准

`screenshot_plain` 截取普通表单，`screenshot_masked` 截取 `/real-form-cases` 的可见敏感字段与跨源框架。两项均只计截图动作，不计进入页面的准备时间。同轮比较 p50，含遮罩的单张截图增加值应不超过 150 ms。其余机械动作以同机同浏览器重新记录的基线为参考，各 p50 不超过该项的 110%。沙箱无法监听基准端口时记录 `EPERM`，不能用离线用例时延替代真实浏览器结果。
