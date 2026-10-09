"""中文注释：固定的搜索、管理和运行入口；复用可信身份与 Python 脚本进程。"""
import json
from pathlib import Path


def schemas():
    # 中文注释：schema 同时用于注册和生成参考文档，参数说明只有一个来源。
    text = {'type': 'string', 'minLength': 1}
    obj = {'type': 'object'}
    def schema(description, properties, required):
        return {'description': description, 'parameters': {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False}}
    return {
        'browser_site_search': schema('搜索已验证的网站工具，返回参数和结果契约；不执行网页动作。', {'query': {'type': 'string'}, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}}, []),
        'browser_site_manage': schema('管理网站工具：define 创建草稿；try 实际执行并校验结果，写工具会产生实际副作用；activate 启用通过验证的草稿；discard 丢弃草稿。definition 必须含 site/name/description/origins/access/args_schema/result_schema/code，code 仅定义 def run(args)。checks 为 path 加 equals 或 min_items 的断言列表。', {
            'action': {'type': 'string', 'enum': ['define', 'try', 'activate', 'discard']}, 'definition': obj, 'draft_id': text,
            'args': obj, 'checks': {'type': 'array', 'items': obj, 'minItems': 1, 'maxItems': 16},
            'timeout_s': {'type': 'integer', 'minimum': 1, 'maximum': 600}}, ['action']),
        'browser_site_run': schema('运行已验证的网站工具；连接授权后普通动作直接执行，沿用当前任务、来源、租约和敏感操作独立确认。access 标签不授予权限。结果未知时不重放。', {'site': text, 'name': text, 'args': obj, 'timeout_s': {'type': 'integer', 'minimum': 1, 'maximum': 600}}, ['site', 'name', 'args']),
    }


SCHEMAS = schemas()


def register(ctx, bridge, runtime, home, *, lease_error, bridge_denied):
    root = Path(__file__).resolve().parent
    import importlib.util
    spec = importlib.util.spec_from_file_location('browser_site_store', root / 'store.py')
    store_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(store_module)
    spec = importlib.util.spec_from_file_location('browser_site_script', root.parent / 'script_lane/tool.py')
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    store = store_module.Store(Path(home) / 'plugin-data/browser-link-native/site-tools')
    runtime.authority.lease_tools(tuple(SCHEMAS))

    def make_handler(name):
        def handler(args, *, session_id=None, **_):
            try:
                lease = runtime.authority.consume(name, args, session_id=session_id)
            except lease_error:
                return json.dumps({'ok': False, 'code': 'session_identity_required'})
            executed = False
            try:
                if set(args) - set(SCHEMAS[name]['parameters']['properties']) - {'__browser_link_owner_lease'}:
                    raise store_module.ToolError('invalid_arguments')
                params = {k: v for k, v in args.items() if k in SCHEMAS[name]['parameters']['properties']}
                timeout = params.get('timeout_s', 120)
                if type(timeout) is not int or not 1 <= timeout <= 600:
                    raise store_module.ToolError('invalid_timeout')

                def execute(definition, arguments):
                    nonlocal executed
                    # 中文注释：先核对已绑定任务来源；代码只在既有子进程中运行，输出必须是完整 JSON。
                    if len(json.dumps(arguments, ensure_ascii=False, allow_nan=False)) > 65536:
                        raise store_module.ToolError('arguments_too_large')
                    bridge.validate_origins(session_id, definition['origins'])
                    code = ('import json as _json, contextlib as _contextlib, sys as _sys\n'
                            + definition['code'] + '\n'
                            + 'with _contextlib.redirect_stdout(_sys.stderr):\n'
                            + '    _result = run(_json.loads(' + repr(json.dumps(arguments, ensure_ascii=False, allow_nan=False)) + '))\n'
                            + 'print(_json.dumps(_result, ensure_ascii=False, allow_nan=False))\n')
                    executed = True
                    receipt = script.run_script(bridge, session_id=session_id, tool_call_id=lease.tool_call_id,
                        workspace=script.workspace_for(home, lease.owner), code=code, timeout_s=timeout)
                    if receipt['outcome_unknown']:
                        raise store_module.ToolError('outcome_unknown')
                    if not receipt['execution_complete']:
                        raise store_module.ToolError('operation_incomplete')
                    if receipt['stdout_truncated']:
                        raise store_module.ToolError('result_truncated')
                    try:
                        return json.loads(receipt['stdout'])
                    except ValueError as exc:
                        raise store_module.ToolError('invalid_result') from exc

                if name == 'browser_site_search':
                    result = store.search(params.get('query', ''), params.get('limit', 20))
                elif name == 'browser_site_run':
                    record = store.get(params['site'], params['name'])
                    definition = record['definition']
                    store_module.validate_value(params['args'], definition['args_schema'])
                    value = execute(definition, params['args'])
                    store_module.validate_value(value, definition['result_schema'])
                    result = {'result': value, 'revision': record['revision']}
                else:
                    action = params['action']
                    required = {'define': {'action', 'definition'}, 'try': {'action', 'draft_id', 'args', 'checks'}, 'activate': {'action', 'draft_id'}, 'discard': {'action', 'draft_id'}}
                    if action not in required or required[action] - set(params) or set(params) - required[action] - ({'timeout_s'} if action == 'try' else set()):
                        raise store_module.ToolError('invalid_arguments')
                    if action == 'define':
                        result = store.define(params['definition'])
                    elif action == 'try':
                        result = store.trial(params['draft_id'], params['args'], params['checks'], execute)
                    elif action == 'activate':
                        result = store.activate(params['draft_id'])
                    else:
                        result = store.discard(params['draft_id'])
                return json.dumps({'ok': True, **result}, ensure_ascii=False, allow_nan=False)
            except bridge_denied:
                return json.dumps({'ok': False, 'code': 'binding_or_origin_denied', 'retryable': False})
            except OSError:
                return json.dumps({'ok': False, 'code': 'local_io_failed', 'retryable': False, 'outcome_unknown': executed})
            except (store_module.ToolError, KeyError, TypeError, ValueError) as exc:
                code = getattr(exc, 'code', 'invalid_arguments')
                return json.dumps({'ok': False, 'code': code, 'retryable': False, 'outcome_unknown': executed and code in {'outcome_unknown', 'result_truncated', 'invalid_result', 'schema_mismatch'}})
        return handler

    for name, schema in SCHEMAS.items():
        ctx.register_tool(name=name, toolset='browser-link', schema=schema, handler=make_handler(name), description=schema['description'], emoji='🌐')
