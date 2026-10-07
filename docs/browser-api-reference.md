# Generated browser API reference

由 `python3 scripts/generate-browser-reference.py` 从实际 helper 和工具 schema 生成。不要手工编辑。

## Task lifecycle

每轮 `on_session_end(completed=True)` 默认立即关闭工作页；显式设置宽限时，同会话再次调用任意 `browser_shared_*` 取消计时。失败、中断和成功映射 owner 的 `agent_loop_stopped(session_key)` 立即按 handoff 结束。

`HERMES_BROWSER_IDLE_CLOSE_SECONDS` 设置完成宽限（0 为立即关闭）；`HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS` 设置 ready 任务空闲上限（默认 1200 秒）。计时由常驻 daemon 管理并持久化，CLI 退出不丢失。

暂停或仍等待人工批准/敏感填写的任务免于空闲扫描。`keep_tabs=true` 仅用于本轮回复明确请用户现在去该页完成验证码、登录、核验或最终提交，或用户明确要求保留；必须传 `handoff_reason`（captcha/login/verification/final_submit/user_requested）。遇阻、结果未知、读不到或被遮挡，记录 URL 和停点后普通关闭；任务结束撤权并收组，保留这些页面和用户页面。浏览器重启后无法验证的旧创建记录不授予清理权限。

## Python helpers

### `parallel(fn, tabs)`

Call fn(tab) concurrently, returning input order; aggregate failures without retries.

扩展能力：`browser_core_v1`。

### `new_tab(url)`

Open a work tab on an approved origin; returns the numeric tab id.

扩展能力：`browser_core_v1`。

### `use_tab(tab_id)`

Select the current owned work tab; prefer explicit tab= for parallel work.

扩展能力：`browser_core_v1`。

### `current_tab()`

Return the explicitly selected work-tab id without guessing the active tab.

扩展能力：`browser_core_v1`。

### `goto_url(url, *, summary=True, tab=None)`

Navigate the work tab to an approved origin.

扩展能力：`browser_core_v1`。

### `wait_for_load(timeout=15.0, *, until='interactive', tab=None)`

Wait until document.readyState reaches ``until``; returns the final state.  The default ``'interactive'`` returns once the DOM is parsed and readable; pass ``until='complete'`` only when images/ads/analytics must finish too. A slow page may replace its document while loading; those transient errors are polled through until the deadline instead of failing.

扩展能力：`browser_core_v1`。

### `page_text(*, tab=None)`

中文注释：返回 dict {url, title, elements, ...}；最小读法 print(page_text()['elements'][:5])，不能切片 dict。

扩展能力：`browser_core_v1`。

### `semantic_snapshot(tab=None, **options)`

中文注释：返回 dict {binding, snapshotId, items, coverage, nextCursor, ...}；读 result['items']，coverage.complete=false 时按 nextCursor 续读。

扩展能力：`browser_core_v1`。

### `parse_page(tab=None, **options)`

中文注释：返回 dict {schemaVersion,parseId,binding,regions,blocks,tables,forms,collections,records,coverage,warnings,nextCursor}；只读取指定 sections/root，结果引用仅作为来源证据。

扩展能力：`page_parse_v1`。

### `page_markdown(tab=None, **options)`

中文注释：Markdown 是当前解析页的派生结果，同时保留分页与覆盖状态。

扩展能力：`page_parse_v1`。

### `extract(schema, tab=None, **options)`

中文注释：返回 parse_page 的 dict；读 result['records']，每项含 fields/states/sources/valid；核对 coverage/warnings/nextCursor，不能把 sourceRef 用于写动作。

扩展能力：`page_parse_v1`。

### `evaluate(function, arguments=None, *, world='isolated', timeout_ms=10000, frame_token=None, tab=None)`

中文注释：返回函数的 JSON 值；evaluate('(selector)=>document.querySelector(selector)?.textContent', '#result') 用 arguments 传数据。isolated 共享 DOM、不共享网站 JS 全局变量；main 仅确需网站变量时显式指定，禁止错误后自动切换。

扩展能力：`page_function_v1`。

### `network_start(*, tab=None)`

中文注释：开始主标签网络观察；返回 captureId，供后续调用防止串用游标。

扩展能力：`network_evidence_v1`。

### `network_list(capture_id, *, after_sequence=0, limit=20, filter='', tab=None)`

中文注释：只读摘要不返回请求头；cursor 表示更新序号，seq 表示请求标识。

扩展能力：`network_evidence_v1`。

### `network_detail(capture_id, seq, *, part='response', start=0, max_chars=8000, tab=None)`

中文注释：按摘要序号读取脱敏 JSON；分页延续同一缓存正文，不重新发送请求。

扩展能力：`network_evidence_v1`。

### `network_stop(*, tab=None)`

中文注释：清空本任务页捕获缓存，不关闭其他等待器使用的 Network 域。

扩展能力：`network_evidence_v1`。

### `page_request(url, *, fields, method='GET', max_bytes=65536, timeout_ms=10000, tab=None)`

中文注释：同源 GET/HEAD 的有界 JSON 字段读取；智能审批先确认，不推断业务无副作用。

扩展能力：`page_function_v1`。

### `wait_for(selector, *, state='present', text=None, count=None, timeout=10, interval=0.25, tab=None)`

中文注释：声明式只读等待，不重试点击、填写或提交；返回 dict {satisfied, timed_out, last_observation, coverage, reason}；timeout 为 (0,60] 秒，state=present/absent/text/count/stable。satisfied=false 后改定位或停止，不重复等同一条件。

扩展能力：`page_parse_v1`。

### `expect_response(url=None, *, timeout=15, tab=None)`



扩展能力：`browser_core_v1`。

### `expect_navigation(url=None, *, timeout=15, tab=None)`



扩展能力：`browser_core_v1`。

### `frame_catalog(*, tab=None)`

列出当前任务页的 frame 及可用的不透明引用。

扩展能力：`browser_core_v1`。

### `read_page(*, query='', root=None, mode='content', budget=3000, cursor=None, tab=None)`

中文注释：返回 dict {binding, snapshotId, items, coverage, nextCursor, ...}，与 semantic_snapshot 相同；print(read_page(root='#results')['items'][:5])。

扩展能力：`browser_core_v1`。

### `wait_for_element(name, *, role=None, root=None, exact=True, timeout=10.0, tab=None, action=None)`

等待唯一且未禁用的元素，返回本次快照和引用；不自动点击。

扩展能力：`browser_core_v1`。

### `click_element(name, *, mode='pointer', tab=None, **options)`

按名称/角色点击一次；effect=observed 表示观察到效果，无效果抛 click_no_effect。

扩展能力：`browser_core_v1`。

### `fill_element(name, text, tab=None, **options)`

按名称/角色定位后填写一次；敏感字段仍转人工处理。

扩展能力：`browser_core_v1`。

### `scroll(direction='down', *, tab=None)`

复用受控页面滚动；滚动后重新定位，不沿用旧元素引用。

扩展能力：`browser_core_v1`。

### `click(selector, *, tab=None)`



扩展能力：`browser_core_v1`。

### `fill(selector, text, *, tab=None)`



扩展能力：`browser_core_v1`。

### `press(selector, key, *, tab=None)`



扩展能力：`browser_core_v1`。

### `ref_click(snapshot, ref, *, mode='pointer', tab=None)`

按语义引用点击一次；依据实际送达回执区分交付方式。

扩展能力：`browser_core_v1`。

### `ref_fill(snapshot, ref, text, *, tab=None)`



扩展能力：`browser_core_v1`。

### `ref_press(snapshot, ref, key, *, tab=None)`

在当前语义目标上派发受限按键，输入前仍须通过敏感字段预审。

扩展能力：`browser_core_v1`。

### `ref_set_checked(snapshot, ref, checked, *, tab=None)`

设置当前语义引用的复选状态；结果由页面状态回读确认。

扩展能力：`browser_core_v1`。

### `ref_select_option(snapshot, ref, values, *, by='value', tab=None)`

按 value、Unicode 标签或零基 index 选择原生选项，并由页面状态回读确认。

扩展能力：`browser_core_v1`。

### `upload_files(selector, artifact_ids=None, *, paths=None, tab=None)`

把文件选择进当前任务页：用户在对话中给出的本地路径（paths），或已登记的文件 ID；网站接收结果须另行读取。

扩展能力：`browser_core_v1`。

### `downloads()`

列出本任务已归属的下载（不含本机路径）与归属未知的计数。

扩展能力：`browser_core_v1`。

### `wait_for_download(timeout=30.0, *, ignore=())`

等待一项本任务新完成的下载；ignore 为调用前已见过的下载编号。只读轮询，不触发下载。

扩展能力：`browser_core_v1`。

### `claim_download(download_id, dest=None)`

领取已完成的下载并复制到工作目录；返回相对路径与摘要。中断或变化的文件不能领取。

扩展能力：`browser_core_v1`。

### `cancel_download(download_id)`

取消本任务仍在进行的一项下载；不影响用户自己的下载。

扩展能力：`browser_core_v1`。

### `js(expression, *, world='isolated', await_promise=True, timeout_ms=10000, frame_token=None, tab=None)`

在任务页运行 JavaScript；智能审批需确认，全部访问直接执行。

扩展能力：`browser_core_v1`。

### `cdp(method, frame_token=None, tab=None, **params)`

原始 CDP 方法；智能审批逐项确认，全部访问直接执行。

扩展能力：`browser_core_v1`。

### `cdp_events(max=200, *, tab=None)`

取出本任务页已订阅的 CDP 事件（有上限，dropped 表示溢出丢弃数）。

扩展能力：`browser_core_v1`。

### `screenshot(path='shot.png', *, tab=None, name=None, selector=None)`

保存视口截图到工作区或配置的导出根，返回绝对路径。

扩展能力：`browser_core_v1`。

### `reconcile(*, tab=None)`

After BrowserError.outcome_unknown: read the page to check what happened, then continue. The uncertain action itself is never resent.

扩展能力：`browser_core_v1`。

### `operation_status(request_id=None)`

只读查询最近一次或指定请求的持久账本；不重发动作。

扩展能力：`browser_core_v1`。

### `reconnect(timeout_s=30.0)`

在当前 Python 栈内等待同一任务恢复；返回后仍需核实未知写入。

扩展能力：`browser_core_v1`。

### `load_checkpoint()`

读取 Hermes 为本次协作式续跑显式提供的业务检查点。

扩展能力：`browser_core_v1`。

### `wait_pending(timeout_s=20.0, *, tab=None)`

After ApprovalRequired, wait for the user's decision on that same request.

扩展能力：`browser_core_v1`。

## Tool schemas

### `browser_shared_cookie_mirror`

```json
{
  "description": "列出 Cookie 站点计数或请求复制登录态。request_mirror 必须由用户在源浏览器扩展确认，全部访问也不能免确认；status 查询同一 transfer_id，不重发。不得索要 Cookie 值或保存 Cookie 内容。",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "list_sites",
          "request_mirror",
          "status"
        ]
      },
      "source": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "target": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "sites": {
        "type": "array",
        "minItems": 1,
        "maxItems": 256,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 253
        }
      },
      "transfer_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 32
      },
      "options": {
        "type": "object",
        "properties": {
          "clearTarget": {
            "type": "boolean"
          },
          "persistDays": {
            "type": "integer",
            "minimum": 1,
            "maximum": 365
          }
        },
        "required": [],
        "additionalProperties": false
      }
    },
    "required": [
      "action"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_health`

```json
{
  "description": "检查共享浏览器桥接服务；不启动或选择浏览器。",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  }
}
```

### `browser_shared_browsers`

```json
{
  "description": "仅在多实例歧义或诊断时调用；通常直接 browser_shared_open。只读列出 Chrome/Edge 实例和主要链接标记；多台可用时 browser_shared_open 优先使用已启用的主要链接。",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  }
}
```

### `browser_shared_create`

```json
{
  "description": "在指定浏览器实例中为给定网站建任务（共享该浏览器的登录状态）。通常直接用 browser_shared_open；就绪后用 new_tab 打开工作页。详见技能 browser-link:use-my-browser。",
  "parameters": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "instance_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "allowed_origins": {
        "type": "array",
        "minItems": 1,
        "maxItems": 64,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      }
    },
    "required": [
      "title",
      "instance_id",
      "allowed_origins"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_list`

```json
{
  "description": "仅列出当前可信会话的共享浏览器任务。",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  }
}
```

### `browser_shared_artifacts`

```json
{
  "description": "列出当前任务中用户已选取的文件元信息；不返回本地路径或文件内容。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      }
    },
    "required": [
      "task_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_downloads`

```json
{
  "description": "查看、领取或取消当前任务页触发的下载。list 返回元信息与归属未知的计数；claim 在下载完成后校验并移入私有目录，返回 localPath 供本会话读取；cancel 只取消本任务仍在进行的下载。归属不明的下载不会出现在列表中。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "action": {
        "type": "string",
        "enum": [
          "list",
          "claim",
          "cancel"
        ]
      },
      "download_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [
      "task_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_run`

```json
{
  "description": "同一页需要两步以上（填表、翻页、采集、点击后读结果）请用一次 browser_shared_script；打开或导航后先看回执摘要，不足再读取页面；同一页不要混用 browser_exec。需要用户处理时列出标签页；会话结束会保留待处理页。在任务的工作页执行一个动作。智能审批下首次读取每个网站需确认，之后同站读取直接执行；tabs 只返回任务标签。返回 approval_required 或 user_input_required 时，等用户处理后用相同 request_id 和参数再查一次，不要改参重发；outcome_unknown 为真时不要重试，先读页面核实。详见技能 browser-link:use-my-browser。 页面执行：智能审批逐项确认 js.evaluate / cdp.send / cdp.events，全部访问直接执行。发生过凭据填写的页面不能运行任意 JS/CDP。原始脚本结果不做字段级脱敏。 read_page/page_text 返回 dict：读 page[\"items\"] / page[\"elements\"]，不能切片 dict；wait_for timeout 上限 60 秒。 JS 用 evaluate(\"(selector)=>document.querySelector(selector)?.textContent\", \"#result\") 传值；isolated 共享 DOM，不共享网站 JS 全局变量，main 需明确理由且不自动切换。 上传：files.upload 传 selector 与 paths（用户在对话中给出的本地文件路径，可用 ~）。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "request_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "action": {
        "type": "string",
        "enum": [
          "api_request",
          "back",
          "cdp.events",
          "cdp.send",
          "click",
          "console",
          "dialog",
          "files.upload",
          "fill",
          "frame_catalog",
          "images",
          "interaction.bounds",
          "interaction.capture",
          "interaction.click",
          "interaction.drag_coordinates",
          "interaction.drag_elements",
          "js.evaluate",
          "navigate",
          "new_tab",
          "page.parse",
          "press",
          "ref_click",
          "ref_fill",
          "ref_press",
          "ref_select_option",
          "ref_set_checked",
          "screenshot",
          "scroll",
          "semantic_snapshot",
          "snapshot",
          "tabs"
        ]
      },
      "fields": {
        "type": "array",
        "minItems": 1,
        "maxItems": 16,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "http_method": {
        "type": "string",
        "enum": [
          "GET",
          "HEAD"
        ]
      },
      "tab_id": {
        "type": "integer",
        "minimum": 0
      },
      "url": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "selector": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "summary": {
        "type": "boolean",
        "description": "navigate 默认附带精简语义摘要；false 关闭。"
      },
      "text": {
        "type": "string",
        "maxLength": 100000
      },
      "key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "options": {
        "type": "object",
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "interactive",
              "content",
              "table"
            ]
          },
          "root": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "query": {
            "type": "string",
            "maxLength": 2000
          },
          "roles": {
            "type": "array",
            "minItems": 0,
            "maxItems": 100,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            }
          },
          "viewport": {
            "type": "boolean"
          },
          "composed": {
            "type": "boolean"
          },
          "accessibility": {
            "type": "boolean"
          },
          "budget": {
            "type": "integer",
            "minimum": 512
          },
          "cursor": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "baselineId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "frameToken": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "sections": {
            "type": "array",
            "maxItems": 5,
            "items": {
              "type": "string",
              "enum": [
                "regions",
                "blocks",
                "tables",
                "forms",
                "collections"
              ]
            }
          },
          "maxScan": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100000
          },
          "schema": {
            "type": "object"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "binding": {
        "type": "object",
        "properties": {
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "documentId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "leaseId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "required": [
          "taskId",
          "documentId",
          "leaseId"
        ],
        "additionalProperties": false
      },
      "snapshot_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "clickMode": {
        "type": "string",
        "enum": [
          "open_link_in_task_tab",
          "pointer"
        ],
        "description": "ref_click 在可见页面确认可信 click 送达；后台页面使用已确认的 DOM 合成点击并标注回退原因，不激活标签页。click/ref_click 的 open_link_in_task_tab 模式显式打开符合条件的链接。"
      },
      "ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "checked": {
        "type": "boolean"
      },
      "frame_token": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "by": {
        "type": "string",
        "enum": [
          "value",
          "label",
          "index"
        ]
      },
      "values": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 1000
            },
            {
              "type": "integer",
              "minimum": 0
            }
          ]
        }
      },
      "artifact_ids": {
        "type": "array",
        "minItems": 1,
        "maxItems": 10,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "paths": {
        "type": "array",
        "minItems": 1,
        "maxItems": 10,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "screenshot_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "point": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          }
        },
        "required": [
          "x",
          "y"
        ],
        "additionalProperties": false
      },
      "expected_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "from": {
        "type": "object",
        "properties": {
          "point": {
            "type": "object",
            "properties": {
              "x": {
                "type": "number"
              },
              "y": {
                "type": "number"
              }
            },
            "required": [
              "x",
              "y"
            ],
            "additionalProperties": false
          },
          "expectedRef": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "point",
          "expectedRef"
        ],
        "additionalProperties": false
      },
      "to": {
        "type": "object",
        "properties": {
          "point": {
            "type": "object",
            "properties": {
              "x": {
                "type": "number"
              },
              "y": {
                "type": "number"
              }
            },
            "required": [
              "x",
              "y"
            ],
            "additionalProperties": false
          },
          "expectedRef": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "point",
          "expectedRef"
        ],
        "additionalProperties": false
      },
      "source": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "target": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "mode": {
        "type": "string",
        "enum": [
          "pointer",
          "html5-synthetic"
        ]
      },
      "steps": {
        "type": "integer",
        "minimum": 2,
        "maximum": 100
      },
      "direction": {
        "type": "string",
        "enum": [
          "up",
          "down"
        ]
      },
      "arguments": {
        "type": [
          "object",
          "array",
          "string",
          "number",
          "boolean",
          "null"
        ]
      },
      "expression": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100000
      },
      "world": {
        "type": "string",
        "enum": [
          "isolated",
          "main"
        ]
      },
      "await_promise": {
        "type": "boolean"
      },
      "timeout_ms": {
        "type": "integer",
        "minimum": 100,
        "maximum": 60000
      },
      "method": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "cdp_params": {
        "type": "object",
        "description": "原始 CDP 参数对象。"
      },
      "target_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "max": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      },
      "clear": {
        "type": "boolean"
      },
      "accept": {
        "type": "boolean"
      },
      "prompt_text": {
        "type": "string",
        "maxLength": 10000
      }
    },
    "required": [
      "task_id",
      "action"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "action": {
              "enum": [
                "api_request",
                "back",
                "cdp.events",
                "cdp.send",
                "click",
                "console",
                "dialog",
                "files.upload",
                "fill",
                "frame_catalog",
                "images",
                "interaction.bounds",
                "interaction.capture",
                "interaction.click",
                "interaction.drag_coordinates",
                "interaction.drag_elements",
                "js.evaluate",
                "navigate",
                "page.parse",
                "press",
                "ref_click",
                "ref_fill",
                "ref_press",
                "ref_select_option",
                "ref_set_checked",
                "screenshot",
                "scroll",
                "semantic_snapshot",
                "snapshot"
              ]
            }
          },
          "required": [
            "action"
          ]
        },
        "then": {
          "required": [
            "tab_id"
          ]
        }
      }
    ]
  }
}
```

### `browser_shared_get`

```json
{
  "description": "读取当前可信会话拥有的任务。 任务就绪时把本会话绑定到它（同一会话只绑定一个任务），供脚本与官方 browser_* 工具使用；结果见 sessionBinding。 接管暂停时设置 until=resumed 等待，默认最多 600 秒；恢复后先重新读页面。排查时设置 include_log=true、log_limit=N 获取最近步骤。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "until": {
        "type": "string",
        "enum": [
          "resumed"
        ]
      },
      "timeout_s": {
        "type": "integer",
        "minimum": 1,
        "maximum": 3600
      },
      "include_log": {
        "type": "boolean"
      },
      "log_limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [
      "task_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_cancel`

```json
{
  "description": "取消当前会话任务并释放其控制权，不影响其他任务或关闭用户标签页。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      }
    },
    "required": [
      "task_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_resume`

```json
{
  "description": "恢复已取消或需同步的任务（新代次）；新任务使用当前浏览器的智能审批或全部访问模式。不会重放结果不确定的动作。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      }
    },
    "required": [
      "task_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_close`

```json
{
  "description": "关闭任务并关掉它新建的工作页；结果看 cleanupState。每轮成功完成默认立即关闭工作页并收组；显式设置完成宽限时，同会话 browser_shared_* 调用取消计时；失败或中断立即按 handoff 结束。keep_tabs=true 仅用于本轮回复明确请用户现在去该页完成一步，必须同时传 handoff_reason（captcha/login/verification/final_submit/user_requested）。遇阻、结果未知、读不到或遮挡时记录 URL 和停点后普通关闭；真正交接时：撤销任务权限、移除遮罩并收组，但不关页面，cleanupReason 为 handed_to_user。cleanup_action=status 只读核实；仅当状态为 pending 且 cleanupRemainingCount 大于 0 时可用 retry。unknown 或 failed 不满足重试门禁，不能重试删页。不会关闭用户自己的页面。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "cleanup_action": {
        "type": "string",
        "enum": [
          "status",
          "retry"
        ]
      },
      "keep_tabs": {
        "type": "boolean"
      },
      "handoff_reason": {
        "type": "string",
        "enum": [
          "captcha",
          "login",
          "verification",
          "final_submit",
          "user_requested"
        ]
      }
    },
    "required": [
      "task_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_script`

```json
{
  "description": "同一页两步以上时，在本会话已就绪的任务中运行一次 Python 脚本并读回核对（填表、翻页、提取、保存）。脚本内可用 new_tab、goto_url、read_page、wait_for_element、click_element、fill_element、scroll、semantic_snapshot、screenshot、reconcile、wait_pending 等函数，每个页面动作仍受审批约束。page_text/read_page 返回 dict，读 elements/items 字段，不能切片 dict；wait_for timeout 上限 60 秒，先检查 satisfied。JS 用 evaluate(function, arguments) 传值。stdout 只打印目标项、coverage、计数和文件路径，大提取物保存在脚本工作区。用法与模板见技能 browser-link:batch-scrape。",
  "parameters": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200000
      },
      "timeout_s": {
        "type": "integer",
        "minimum": 1,
        "maximum": 3600
      },
      "resume_checkpoint": {
        "type": "object",
        "description": "Hermes 明确提供的业务检查点；脚本用 load_checkpoint() 读取，不自动重放旧动作。"
      }
    },
    "required": [
      "code"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_open`

```json
{
  "description": "一步开始浏览器工作：按显式 instance_id、主要链接、环境默认值或唯一实例选择浏览器，为该网址的网站建立或复用本会话任务，等待授权、绑定会话并打开工作标签页。同源默认复用当前工作页；new_task=true 才新建任务。回执默认含可直接用于 ref 动作的摘要，read_intent=content 读正文，interactive 读控件；loading 时 summary_missing.reason=page_loading，按 read_hint 在原页有界等待后读取。多步页面操作用一次 browser_shared_script，单步用 browser_shared_run；同一页不要混用 browser_exec。",
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "instance_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "new_task": {
        "type": "boolean",
        "description": "明确要求为同网站新建任务。"
      },
      "summary": {
        "type": "boolean",
        "description": "默认附带精简摘要；已有读取计划时 false 可关闭。"
      },
      "read_intent": {
        "type": "string",
        "enum": [
          "content",
          "interactive"
        ],
        "description": "正文阅读用 content，操作控件用 interactive（默认）；单次采集，保留 binding/coverage。"
      },
      "root": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512,
        "description": "摘要的目标 CSS 区域。"
      }
    },
    "required": [
      "url"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_use_tab`

```json
{
  "description": "将本会话官方 browser_* 工具的当前页切换为已绑定任务的工作页。",
  "parameters": {
    "type": "object",
    "properties": {
      "tab_id": {
        "type": "integer",
        "minimum": 0
      }
    },
    "required": [
      "tab_id"
    ],
    "additionalProperties": false
  }
}
```

### `browser_site_search`

```json
{
  "description": "搜索已验证的网站工具，返回参数和结果契约；不执行网页动作。",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  }
}
```

### `browser_site_manage`

```json
{
  "description": "管理网站工具：define 创建草稿；try 实际执行并校验结果，写工具会产生实际副作用；activate 启用通过验证的草稿；discard 丢弃草稿。definition 必须含 site/name/description/origins/access/args_schema/result_schema/code，code 仅定义 def run(args)。checks 为 path 加 equals 或 min_items 的断言列表。",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "define",
          "try",
          "activate",
          "discard"
        ]
      },
      "definition": {
        "type": "object"
      },
      "draft_id": {
        "type": "string",
        "minLength": 1
      },
      "args": {
        "type": "object"
      },
      "checks": {
        "type": "array",
        "items": {
          "type": "object"
        },
        "minItems": 1,
        "maxItems": 16
      },
      "timeout_s": {
        "type": "integer",
        "minimum": 1,
        "maximum": 600
      }
    },
    "required": [
      "action"
    ],
    "additionalProperties": false
  }
}
```

### `browser_site_run`

```json
{
  "description": "运行已验证的网站工具；沿用当前任务、来源、租约和审批。access 标签不授予权限。结果未知时不重放。",
  "parameters": {
    "type": "object",
    "properties": {
      "site": {
        "type": "string",
        "minLength": 1
      },
      "name": {
        "type": "string",
        "minLength": 1
      },
      "args": {
        "type": "object"
      },
      "timeout_s": {
        "type": "integer",
        "minimum": 1,
        "maximum": 600
      }
    },
    "required": [
      "site",
      "name",
      "args"
    ],
    "additionalProperties": false
  }
}
```

### `browser_shared_reference`

```json
{
  "description": "查询实际 Python helper 签名。指定 instance_id 后按已连接扩展能力展示；未连接时不宣称浏览器接口可用。",
  "parameters": {
    "type": "object",
    "properties": {
      "instance_id": {
        "type": "string"
      },
      "query": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

### `browser_shared_doctor`

```json
{
  "description": "只读检查插件安装、Native Messaging 注册、宿主和扩展连接，给出修复建议；不启动、重启或恢复授权。",
  "parameters": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```
