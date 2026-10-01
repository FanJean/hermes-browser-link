"""中文注释：接口文档由实际 helper 和工具 schema 生成；在线查询按扩展能力裁剪。"""
import ast
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FEATURES = {'network_start': 'network_evidence_v1', 'network_list': 'network_evidence_v1',
            'network_detail': 'network_evidence_v1', 'network_stop': 'network_evidence_v1',
            'page_request': 'page_function_v1', 'evaluate': 'page_function_v1',
            'parse_page': 'page_parse_v1', 'extract': 'page_parse_v1', 'page_markdown': 'page_parse_v1',
            'wait_for': 'page_parse_v1'}
SCHEMAS = {
    'browser_shared_reference': {'description': '查询实际 Python helper 签名。指定 instance_id 后按已连接扩展能力展示；未连接时不宣称浏览器接口可用。', 'parameters': {'type': 'object', 'properties': {'instance_id': {'type': 'string'}, 'query': {'type': 'string'}}, 'additionalProperties': False}},
    'browser_shared_doctor': {'description': '只读检查插件安装、Native Messaging 注册、宿主和扩展连接，给出修复建议；不启动、重启或恢复授权。', 'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
}


def load(path):
    spec = importlib.util.spec_from_file_location('browser_reference_' + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def helper_catalog():
    # 中文注释：从 HELPERS 真正导出的名字生成签名，不把私有函数误列为能力。
    tree = ast.parse((ROOT / 'script_lane/child.py').read_text())
    exported = next(node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'HELPERS' for t in node.targets))
    names = ast.literal_eval(exported.value.generators[0].iter)
    return [{'name': node.name, 'signature': node.name + '(' + ast.unparse(node.args) + ')',
             'description': ast.get_docstring(node) or '', 'requires': FEATURES.get(node.name, 'browser_core_v1')}
            for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]


def render():
    tools = {**load(ROOT / 'native_tools.py').TOOL_SCHEMAS,
             'browser_shared_script': load(ROOT / 'script_lane/tool.py').SCHEMA,
             'browser_shared_open': load(ROOT / 'open_tool.py').SCHEMA,
             'browser_shared_use_tab': load(ROOT / 'open_tool.py').USE_TAB_SCHEMA,
             **load(ROOT / 'site_tools/tools.py').SCHEMAS, **SCHEMAS}
    # 中文注释：生命周期约定与工具 schema 一起生成，API 参考检查也覆盖默认计时和移交语义。
    lines = ['# Generated browser API reference', '', '由 `python3 scripts/generate-browser-reference.py` 从实际 helper 和工具 schema 生成。不要手工编辑。', '',
             '## Task lifecycle', '',
             '每轮 `on_session_end(completed=True)` 默认宽限 600 秒；同会话再次调用任意 `browser_shared_*` 取消宽限。失败、中断和成功映射 owner 的 `agent_loop_stopped(session_key)` 立即按 handoff 结束。', '',
             '`HERMES_BROWSER_IDLE_CLOSE_SECONDS` 设置完成宽限（0 为立即关闭）；`HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS` 设置 ready 任务空闲上限（默认 3600 秒）。计时由常驻 daemon 管理并持久化，CLI 退出不丢失。', '',
             '暂停或仍等待人工批准/敏感填写的任务免于空闲扫描。需要用户继续操作的页面必须 `keep_tabs=true`；任务结束撤权并收组，保留这些页面和用户页面。浏览器重启后无法验证的旧创建记录不授予清理权限。', '',
             '## Python helpers', '']
    for helper in helper_catalog():
        lines += ['### `' + helper['signature'] + '`', '', helper['description'].replace('\n', ' '), '', '扩展能力：`' + helper['requires'] + '`。', '']
    lines += ['## Tool schemas', '']
    # 中文注释：保留完整 JSON schema，避免手工参数表与注册接口漂移。
    for name, schema in tools.items():
        lines += ['### `' + name + '`', '', '```json', json.dumps(schema, ensure_ascii=False, indent=2), '```', '']
    return '\n'.join(lines)


def project(browsers, instance_id, query=''):
    selected = next((b for b in browsers if b.get('instanceId') == instance_id and b.get('connected') is True), None)
    features = selected.get('features', []) if selected else []
    return {'connected': selected is not None, 'features': features,
            'helpers': [h for h in helper_catalog() if h['requires'] in features and query.lower() in (h['name'] + ' ' + h['description']).lower()],
            'tools': list(SCHEMAS) + ['browser_site_search', 'browser_site_manage', 'browser_site_run'],
            'browsers': [{'instance_id': b.get('instanceId'), 'features': b.get('features', [])} for b in browsers if b.get('connected') is True],
            'note': '能力存在不代表已授权；页面调用仍检查任务和浏览器访问。'}


def register(ctx, runtime, home, *, lease_error):
    runtime.authority.lease_tools(tuple(SCHEMAS))
    def make_handler(name):
        def handler(args, *, session_id=None, **_):
            try:
                runtime.authority.consume(name, args, session_id=session_id)
            except lease_error:
                return json.dumps({'ok': False, 'code': 'session_identity_required'})
            if name == 'browser_shared_doctor':
                path = ROOT / 'native_bridge/doctor.py'
                if not path.is_file():
                    path = ROOT.parent / 'native-bridge/doctor.py'
                return json.dumps(load(path).diagnose(home), ensure_ascii=False)
            try:
                query = args.get('query', '')
                if not isinstance(query, str) or len(query) > 500:
                    return json.dumps({'ok': False, 'code': 'invalid_arguments'})
                # 中文注释：使用只读探针，不通过可能启动服务的常规 RPC 客户端。
                path = ROOT / 'native_bridge/doctor.py'
                if not path.is_file():
                    path = ROOT.parent / 'native-bridge/doctor.py'
                live = load(path).probe(home)
                return json.dumps(project(live.get('browsers', []), args.get('instance_id'), query), ensure_ascii=False)
            except (OSError, ValueError):
                return json.dumps({'ok': False, 'code': 'reference_unavailable'})
        return handler
    for name, schema in SCHEMAS.items():
        ctx.register_tool(name=name, toolset='browser-link', schema=schema, handler=make_handler(name), description=schema['description'], emoji='🔎')
