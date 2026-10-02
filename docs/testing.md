# Testing

## 1.4.4 bounded waits

离线测试 `tests/v1.4.4/test_round1f.py` 与 `round1f.test.mjs` 已纳入 npm 门禁；`replay-check.py` 只使用动作/错误码白名单和合成契约。

```bash
# 中文注释：手动夹具使用临时 profile；不属于离线入口。
node tests/v1.4.4/real-round1f.mjs
node tests/v1.4.4/real-round1f.mjs --edge
```

真实等待命中比较旧/新算法各五次，完整解析需减少至少 70%，p50 命中延迟不退步。机械基准仍需相同浏览器和起点 1.4.3，p50 退步不超过 10%。受限环境无法启动服务时，应记录阻塞并在可运行环境复查。

## 1.4.3 automatic cleanup

`npm test` includes `tests/v1.4.3/autoclose.test.mjs` and `tests/v1.4.3/test_autoclose.py`. They use synthetic browser APIs, temporary ledgers and the actual plugin hooks. Run the real fixture separately on your Mac:

```sh
node tests/v1.4.3/real-autoclose.mjs
node tests/v1.4.3/real-autoclose.mjs --edge
```

The fixture uses a temporary profile and local server. Its completed hook runs in a short-lived Python process, followed by session finalize, while the daemon retains a three-second grace. It covers continuation cancelling grace, stop/interrupted/failed immediate closure, group renaming, `keep_tabs=true` page retention and an unchanged user-created group with the same title. It is not part of the offline runner. Mechanical navigation/click/fill p50 must remain within 110% of the same-browser baseline; use [the benchmark commands](bench.md).

## Self-contained tests

Node.js 22.12+ and Python 3.11+ are sufficient. No Hermes install, browser, account or API key is required:

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run check:js
npm run check:docs
```

The core runner uses explicit Node and Python lists. Its React renderer uses this repository's locked development dependencies, not a personal Hermes checkout. Production plugins still use Hermes' React runtime. Core tests never launch browsers or register Native Messaging hosts.

## Full integration gate

`npm run verify` additionally imports the real Hermes plugin loader and tests API boundaries. It is intentionally separate from the core suite. Prepare an isolated test checkout, never overwrite your personal Hermes installation:

```sh
# 中文注释：使用固定 Hermes 提交，测试目录被 Git 忽略。
git clone --no-checkout https://github.com/NousResearch/hermes-agent.git .ci/hermes
git -C .ci/hermes checkout --detach e62a47ab680bf952b26559e540c28bc18571017c
uv sync --project .ci/hermes --frozen --no-dev --extra web --python 3.14
uv pip install --python .ci/hermes/.venv/bin/python PyYAML==6.0.3
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" npm run verify
```

Use uv 0.11.2 for this recipe. The setup downloads upstream dependencies; the subsequent gate is offline. No provider credentials are needed. You may instead set `HERMES_SOURCE` and `HERMES_PYTHON` to an existing test installation. Browser Use CLI is only needed for real-browser official-tool acceptance, not for the offline suites; those use synthetic CLI fixtures.

The gate copies the working tree to a private scratch directory, runs every reviewed Node/Python suite, checks source drift, and writes `tests/v1.1-verification/latest.json` (ignored by Git). `.ci/`, build products and local evidence are excluded from the source snapshot. Existing `v1.1` runner names are retained as test-area names, not a claim that the current release is V1.1.

The lists are `NODE_TESTS`, `PYTHON_SUITES` and `REVIEWED_RUNNER_PATHS` in `scripts/verify-v1.1-offline.py`; `coverage-matrix.md` checks their inventory. A failing, zero-test, skipped or timed-out suite cannot turn the full gate green. Browser and installation runners remain opt-in.

## CI

- `checks.yml`: core tests, lint, syntax, documentation and package closure on Ubuntu and macOS, using Node 22 and Python 3.11; no credentials.
- `integration.yml`: macOS full gate on `main` pushes or manual dispatch against the pinned Hermes commit above. It uploads the gate report and never touches a personal installation.
- `secrets.yml`: a pinned Gitleaks binary checks the checked-out Git history; forks use read-only permissions. Public publishing still requires the separate clean-history checklist in [releasing.md](releasing.md).

To run a single suite:

```sh
node --test tests/v1.1-overlay/integration.test.mjs
python3 -m unittest discover -s native-bridge/tests -p 'test_tasks.py' -v
```

Set `TMPDIR` to a scratch directory; several tests create temporary homes and sockets there.

### Adding tests

- Put tests next to the feature area (`tests/<area>/`, or the module's own test directory).
- Add every new offline test file to the explicit lists in `scripts/verify-v1.1-offline.py` and to `coverage-matrix.md`; `tests/v1.1-verification/test_gate.py` checks that they agree.
- Tests must write only to temporary directories, never into the repository.

## Real-browser tests

Real-browser runners (`real-*.mjs`, `*acceptance*.mjs`, `tests/v1-headed/`, `tests/v1.1-advanced/real-*.mjs`) launch Chrome or Edge with a fresh temporary profile, load the extension from source or a package, and drive real pages. They are opt-in and are never part of `npm test` or `npm run verify`.

Rules for any runner that launches a browser:

- Use a fresh `mkdtemp` profile and remove it afterwards. Never use or copy a personal profile, cookies or login data.
- Pass `--use-mock-keychain --password-store=basic`.
- **Keep the real `HOME`.** Only `HERMES_HOME` / `TMPDIR` may point to scratch. On macOS, a browser started with a scratch `HOME` has no keychain and Edge shows a "cannot find keychain" dialog — click *Cancel*, never *Reset to default*. `tests/v1-launch-safety` enforces this.
- Stage Native Messaging hosts only inside the temporary profile or an isolated home; never register them for your real browser.
- Terminate only the processes you started; do not use broad `pkill`.
- Write run outputs (JSON reports, screenshots) to ignored `evidence/` directories or scratch, not to tracked files.

`python3 tests/check-browser-launchers.py --strict` lists launchers in the repository and fails if a direct launcher lacks the mock-keychain flag.

Useful runners:

| Runner | Covers |
|---|---|
| `tests/native-v2/real-native-v2.mjs` | Full Hermes hook → daemon → extension chain on synthetic pages |
| `tests/native-extension/real-bridge.mjs` | Real Native Messaging framing, concurrent tasks, cross-browser |
| `tests/v1.1-advanced/real-matrix.mjs`, `real-controls.mjs`, `real-recovery.mjs`, `real-official.mjs` | Interaction matrix, controls, recovery, official-tool compatibility |
| `browser-workspaces/real-browser-acceptance.mjs` | Tab-group ownership and cleanup |
| `page-semantics/test.mjs`, `browser-interactions/test/acceptance.mjs` | Module behavior in a real Chromium page |

Run them one at a time and not beside another browser run. A passing historical run does not certify changed code — rerun what your change touches.

## Website-tool and network acceptance

`npm test` also checks `tests/site-tools/`, `tests/network-evidence/network.test.mjs` and generated API-reference drift. Run the packaged Chrome/Edge flow with `node tests/site-tools/real-sites.mjs --browser=all` using the same `HERMES_SOURCE` and `HERMES_PYTHON` test installation as the full gate. It uses temporary profiles, synthetic HttpOnly cookies and a local HTTP fixture. It does not verify third-party sites or modify a personal installation. Evidence is written under ignored `tests/site-tools/evidence/`.

The website-tool suite includes caught-error trials for unknown outcomes, pending approval and manual input. The packaged browser flow also checks capture continuity across navigation, rejection of an existing CDP session after leaving the allowed origins, and recovery through a newly opened gateway.

## Cookie mirror acceptance

The offline gate includes the Node and Python runners under `tests/v1.5.0/`. They use synthetic cookies and temporary state; they do not launch browsers.

Real login acceptance is opt-in and uses temporary profiles with a shared temporary daemon and a loopback fixture. Run manually on a machine with Chrome and Edge installed:

```sh
node tests/v1.5.0/real-cookie-mirror.mjs
```

Prefer `--headed` (and `--same-browser --headed` for two Chrome profiles): the confirmation panel opens only after the source window is verifiably focused, which headless browsers do not reliably report, so headless runs can fall back to the popup's pending-confirmation button or time out. The fixture issues randomized ordinary, httpOnly session and partitioned cookies; the runner checks source rejection, popup confirmation, import counts, readback and the target protected page, then scans every file in the temporary state (except the browser profiles' own cookie stores) and the session logs for the fixture values. `COOKIE_LEAK_SELFTEST=1` plants one value in the daemon directory and must make the run fail, proving the scan is effective. Missing partitioned-cookie support fails acceptance. Cookie values are never printed or saved. See [usage](usage.md#cookie-mirror) for limitations.

### Desktop Cookie mirror (1.5.1)

The offline gate includes `executor-plugin/desktop/cookie-mirror.test.mjs` and `tests/v1.5.1/test_desktop_cookie_mirror.py`. They verify real React/Query rendering and synthetic HTTP/runtime/daemon flows, including canary values in malformed inputs, bridge responses, errors and rendered HTML. The Python API runner needs the existing FastAPI, Pydantic and HTTPX test environment.

Manual acceptance uses the same temporary-profile launcher as 1.5.0. It sends HTTP requests through the real desktop API router via a TestClient fixture bound to the temporary profile, then performs a real click in the source extension confirmation panel and verifies the target's protected page. It does not launch the Hermes Desktop host; host rendering is covered separately by the offline desktop tests.

```sh
node tests/v1.5.1/real-desktop-cookie-mirror.mjs --headed
node tests/v1.5.1/real-desktop-cookie-mirror.mjs --headed --same-browser
COOKIE_LEAK_SELFTEST=1 node tests/v1.5.1/real-desktop-cookie-mirror.mjs --headed
```

Set `HERMES_PYTHON` to the existing test Python with FastAPI/HTTPX and Hermes dependencies when needed. The self-test deliberately plants a synthetic cookie value in the temporary daemon directory and must fail the leak scan. Both normal modes must pass without it. These scripts are never part of `npm test` or the offline gate.
