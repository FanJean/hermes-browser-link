# executor-plugin

The Hermes plugin `browser-link`. It is installed as `$HERMES_HOME/plugins/browser-link/` and uses only Hermes' public plugin API.

## Contents

| Path | Role |
|---|---|
| `__init__.py` | Registration: tools, owner-lease hook, skills, system-prompt pointer, optional overrides |
| `native_tools.py`, `native_runtime.py`, `runtime.py` | `browser_shared_*` tools, schemas, trusted session → one-use owner lease, result projection |
| `open_tool.py` | `browser_shared_open`: choose browser, create or reuse task, wait for authorization, bind session, open work tab |
| `script_lane/` | `browser_shared_script`: script host, action session and the child-process helpers |
| `single_tool_adapter/` | Routes Hermes' official `browser_*` tools and `browser_exec` to the bound task |
| `vault_adapter/` | Optional routing of Hermes' Vault tools through the private fill channel |
| `dashboard/` | HTTP API mounted at `/api/plugins/browser-link` |
| `desktop/` | The Hermes Desktop "Browser work" page |
| `skills/` | Skills the model reads: `use-my-browser`, `batch-scrape`, `troubleshoot` |
| `task_diagnostics.py` | Task log and diagnostics projection |

## Official tool overrides

When the operator grants the plugin `tools.override`, the plugin re-registers Hermes' official browser tools with `override=True`. A session bound to a ready task is served by the bridge; every other session calls the original handler unchanged. A call without trusted session and tool-call identity gets no lease and falls back to the built-in handler; a bound session without a lease is refused rather than routed elsewhere. No Hermes source is patched.

## 1.7.1 user-facing controls

The browser popup shows the extension version, browser access mode, task controls and automatic content shielding. The task cursor is always enabled and stays visible between steps. Content protection is enforced in the extension output boundary and preserved by the plugin's allowlisted result projection; unsupported or stale protected outputs are not retried through raw channels.

Hermes Desktop provides browser links and Cookie mirror controls. Mirroring always needs a fresh source-extension confirmation. The native mirror dialog uses an opaque, centered elevated surface and fits narrow/short windows. Stable-release updates are managed by `maintenance/update.py`; pre-releases are excluded. See [feature catalog](../docs/features.md) and [usage](../docs/usage.md).

## Tests

```sh
"$HERMES_PYTHON" -m unittest discover -s executor-plugin/tests -v
node --test executor-plugin/desktop/*.test.mjs
```

`HERMES_PYTHON` must be the interpreter of a Hermes environment, because some tests import Hermes.
