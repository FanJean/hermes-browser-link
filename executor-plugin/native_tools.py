"""Trusted tool registration for the independent shared-profile browser bridge.

Parent integration: load this module by path; call runtime_module(), then
get_native_profile_runtime(home, plugin_root), then register_native_context(ctx,
runtime, cleanup=...). Export TOOL_SCHEMAS/TOOL_NAMES for manifest alignment.
The ninth tool is health; browsers enumerates explicit connected instance IDs.
Neither schemas nor RPC adapters accept a model-provided owner or approval.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import math
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def runtime_module():
    path = Path(__file__).with_name('native_runtime.py').resolve()
    name = 'hermes_browser_native_runtime_' + hashlib.sha256(str(path).encode()).hexdigest()[:16]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError('无法加载共享浏览器组件')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return sys.modules[name]


_runtime = runtime_module()
TOOL_NAMES = _runtime.TOOL_NAMES
_METHODS = dict(zip(TOOL_NAMES, ('health', 'browser.list', 'shared.create', 'shared.list',
                               'shared.get', 'shared.artifacts', 'shared.run', 'shared.cancel', 'shared.resume', 'shared.close',
                               'shared.downloads', 'browser.cookie_mirror')))
_DOWNLOAD_METHODS = {'list': 'shared.downloads', 'claim': 'shared.download_claim', 'cancel': 'shared.download_cancel'}


def _object(properties, required=()):
    return {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False}


def _text(limit=256):
    return {'type': 'string', 'minLength': 1, 'maxLength': limit}


def _number():
    return {'type': 'number'}


def _point():
    return _object({'x': _number(), 'y': _number()}, ('x', 'y'))


def _binding():
    return _object({'taskId': _text(128), 'documentId': _text(128), 'leaseId': _text(128)},
                   ('taskId', 'documentId', 'leaseId'))


def _endpoint():
    return _object({'point': _point(), 'expectedRef': _text(256)}, ('point', 'expectedRef'))


def _semantic_options():
    return _object({
        'mode': {'type': 'string', 'enum': ['interactive', 'content', 'table']},
        'root': _text(4096),
        'query': {'type': 'string', 'maxLength': 2000},
        'roles': {'type': 'array', 'minItems': 0, 'maxItems': 100, 'items': _text(100)},
        'viewport': {'type': 'boolean'},
        'composed': {'type': 'boolean'},
        'budget': {'type': 'integer', 'minimum': 512},
        'cursor': _text(512),
        'baselineId': _text(512),
        'frameToken': _text(128),
    })


TOOL_SCHEMAS = {
    'browser_shared_cookie_mirror': {
        'description': '列出 Cookie 站点计数或请求复制登录态。request_mirror 必须由用户在源浏览器扩展确认，全部访问也不能免确认；status 查询同一 transfer_id，不重发。不得索要 Cookie 值或保存 Cookie 内容。',
        'parameters': _object({'action': {'type': 'string', 'enum': ['list_sites', 'request_mirror', 'status']},
            'source': _text(), 'target': _text(), 'sites': {'type': 'array', 'minItems': 1, 'maxItems': 256, 'items': _text(253)},
            'transfer_id': _text(32), 'options': _object({'clearTarget': {'type': 'boolean'},
                'persistDays': {'type': 'integer', 'minimum': 1, 'maximum': 365}})}, ('action',))},
    'browser_shared_health': {'description': '检查共享浏览器桥接服务；不启动或选择浏览器。', 'parameters': _object({})},
    'browser_shared_browsers': {'description': '仅在多实例歧义或诊断时调用；通常直接 browser_shared_open。只读列出 Chrome/Edge 实例和主要链接标记；多台可用时 browser_shared_open 优先使用已启用的主要链接。', 'parameters': _object({})},
    'browser_shared_create': {
        'description': '在指定浏览器实例中为给定网站建任务（共享该浏览器的登录状态）。通常直接用 browser_shared_open；就绪后用 new_tab 打开工作页。详见技能 browser-link:use-my-browser。',
        'parameters': _object({'title': _text(200), 'instance_id': _text(),
                               'allowed_origins': {'type': 'array', 'minItems': 1, 'maxItems': 64, 'items': _text(2048)}},
                              ('title', 'instance_id', 'allowed_origins'))},
    'browser_shared_list': {'description': '仅列出当前可信会话的共享浏览器任务。', 'parameters': _object({})},
    # 中文注释：文件 ID 由用户在可信界面选取后生成，模型仅能读取已登记元信息。
    'browser_shared_artifacts': {'description': '列出当前任务中用户已选取的文件元信息；不返回本地路径或文件内容。',
                                 'parameters': _object({'task_id': _text()}, ('task_id',))},
    # 中文注释：任务页触发的下载只在唯一归属时登记；领取前校验完整、大小与摘要。
    'browser_shared_downloads': {
        'description': ('查看、领取或取消当前任务页触发的下载。list 返回元信息与归属未知的计数；claim 在下载完成后校验并移入私有目录，'
                        '返回 localPath 供本会话读取；cancel 只取消本任务仍在进行的下载。归属不明的下载不会出现在列表中。'),
        'parameters': _object({'task_id': _text(), 'action': {'type': 'string', 'enum': ['list', 'claim', 'cancel']},
                               'download_id': _text(64)}, ('task_id',))},
    'browser_shared_run': {
        'description': '同一页需要两步以上（填表、翻页、采集、点击后读结果）请用一次 browser_shared_script；打开或导航后先看回执摘要，不足再读取页面；同一页不要混用 browser_exec。需要用户处理时列出标签页；会话结束会保留待处理页。' + '在任务的工作页执行一个动作。智能审批下首次读取每个网站需确认，之后同站读取直接执行；tabs 只返回任务标签。返回 approval_required 或 user_input_required 时，等用户处理后用相同 request_id 和参数再查一次，不要改参重发；outcome_unknown 为真时不要重试，先读页面核实。详见技能 browser-link:use-my-browser。',
        'parameters': _object({'task_id': _text(), 'request_id': _text(),
            'action': {'type': 'string', 'enum': [
                'navigate', 'snapshot', 'click', 'fill', 'press', 'screenshot', 'tabs', 'new_tab', 'api_request',
                'page.parse', 'semantic_snapshot', 'frame_catalog', 'ref_click', 'ref_fill', 'ref_press', 'ref_set_checked', 'ref_select_option',
                'interaction.capture', 'interaction.bounds', 'interaction.click',
                'interaction.drag_coordinates', 'interaction.drag_elements', 'files.upload']},
            'fields': {'type': 'array', 'minItems': 1, 'maxItems': 16, 'items': _text(64)},
            'http_method': {'type': 'string', 'enum': ['GET', 'HEAD']},
            'tab_id': {'type': 'integer', 'minimum': 0}, 'url': _text(4096), 'selector': _text(4096),
            'summary': {'type': 'boolean', 'description': 'navigate 默认附带精简语义摘要；false 关闭。'},
            'text': {'type': 'string', 'maxLength': 100000}, 'key': _text(128),
            'options': _semantic_options(), 'binding': _binding(), 'snapshot_id': _text(512),
            'clickMode': {'type': 'string', 'enum': ['open_link_in_task_tab', 'pointer'],
                          'description': 'ref_click 在可见页面确认可信 click 送达；后台页面使用已确认的 DOM 合成点击并标注回退原因，不激活标签页。click/ref_click 的 open_link_in_task_tab 模式显式打开符合条件的链接。'},
            'ref': _text(256), 'checked': {'type': 'boolean'},
            'frame_token': _text(128),
            'by': {'type': 'string', 'enum': ['value', 'label', 'index']},
            'values': {'type': 'array', 'maxItems': 100, 'items': {'oneOf': [
                {'type': 'string', 'maxLength': 1000}, {'type': 'integer', 'minimum': 0}]}},
            # 中文注释：兼容原有的用户登记文件 ID；也可传用户在对话中指定的本地路径。
            'artifact_ids': {'type': 'array', 'minItems': 1, 'maxItems': 10, 'items': _text(64)},
            # 中文注释：用户在对话中给出的本地文件路径（可用 ~）；与 artifact_ids 二选一。
            'paths': {'type': 'array', 'minItems': 1, 'maxItems': 10, 'items': _text(4096)},
            'screenshot_id': _text(256), 'point': _point(),
            'expected_ref': _text(256), 'from': _endpoint(), 'to': _endpoint(),
            'source': _text(4096), 'target': _text(4096),
            'mode': {'type': 'string', 'enum': ['pointer', 'html5-synthetic']},
            'steps': {'type': 'integer', 'minimum': 2, 'maximum': 100},
            'direction': {'type': 'string', 'enum': ['up', 'down']},
            # 中文注释：页面执行参数；所有能力共用任务已有的浏览器访问。
            'arguments': {'type': ['object', 'array', 'string', 'number', 'boolean', 'null']},
            'expression': {'type': 'string', 'minLength': 1, 'maxLength': 100000},
            'world': {'type': 'string', 'enum': ['isolated', 'main']},
            'await_promise': {'type': 'boolean'}, 'timeout_ms': {'type': 'integer', 'minimum': 100, 'maximum': 60000},
            'method': _text(128), 'cdp_params': {'type': 'object', 'description': '原始 CDP 参数对象。'},
            'target_id': _text(128),
            'max': {'type': 'integer', 'minimum': 1, 'maximum': 500},
            'clear': {'type': 'boolean'}, 'accept': {'type': 'boolean'}, 'prompt_text': {'type': 'string', 'maxLength': 10000}},
            ('task_id', 'action'))},
}
# Explicit public capability gate, independent of smart/full approval modes.
PUBLIC_ACTIONS = frozenset({
    'navigate', 'snapshot', 'click', 'fill', 'press', 'screenshot', 'tabs', 'new_tab',
    'page.parse', 'semantic_snapshot', 'frame_catalog', 'ref_click', 'ref_fill', 'ref_press', 'ref_set_checked', 'ref_select_option', 'api_request',
    'interaction.capture', 'interaction.bounds', 'interaction.click',
    'interaction.drag_coordinates', 'interaction.drag_elements',
    'files.upload',
    'scroll', 'back',
    'js.evaluate', 'cdp.send', 'cdp.events',
    'images', 'console', 'dialog',
})
_run_schema = TOOL_SCHEMAS['browser_shared_run']['parameters']
TOOL_SCHEMAS['browser_shared_run']['description'] += (
    ' 页面执行：智能审批逐项确认 js.evaluate / cdp.send / cdp.events，全部访问直接执行。'
    '发生过凭据填写的页面不能运行任意 JS/CDP。原始脚本结果不做字段级脱敏。'
    ' read_page/page_text 返回 dict：读 page["items"] / page["elements"]，不能切片 dict；wait_for timeout 上限 60 秒。'
    ' JS 用 evaluate("(selector)=>document.querySelector(selector)?.textContent", "#result") 传值；isolated 共享 DOM，不共享网站 JS 全局变量，main 需明确理由且不自动切换。'
    ' 上传：files.upload 传 selector 与 paths（用户在对话中给出的本地文件路径，可用 ~）。')
_run_schema['properties']['action']['enum'] = sorted(PUBLIC_ACTIONS)
# 中文注释：仅 tabs/new_tab 不要求工作标签；schema 与运行时使用同一动作边界。
_run_schema['allOf'] = [{'if': {'properties': {'action': {'enum': sorted(PUBLIC_ACTIONS - {'tabs', 'new_tab'})}}, 'required': ['action']}, 'then': {'required': ['tab_id']}}]
# 中文注释：公开解析选项；语义快照仍由 daemon 验证其专属字段。
_run_schema['properties']['options']['properties'].update({
    'sections': {'type': 'array', 'maxItems': 5, 'items': {'type': 'string', 'enum': ['regions', 'blocks', 'tables', 'forms', 'collections']}},
    'maxScan': {'type': 'integer', 'minimum': 1, 'maximum': 100000},
    'schema': {'type': 'object'},
})

for suffix, description in (
    ('get', '读取当前可信会话拥有的任务。'),
    ('cancel', '取消当前会话任务并释放其控制权，不影响其他任务或关闭用户标签页。'),
    ('resume', '恢复已取消或需同步的任务（新代次）；新任务使用当前浏览器的智能审批或全部访问模式。不会重放结果不确定的动作。'),
    ('close', '关闭任务并关掉它新建的工作页；结果看 cleanupState。每轮完成默认宽限 10 分钟自动收组，同会话再次调用 browser_shared_* 取消宽限；失败或中断立即按 handoff 结束。keep_tabs=true 表示把工作页交给用户（如需用户完成验证码后提交）：撤销任务权限、移除遮罩并收组，但不关页面，cleanupReason 为 handed_to_user。cleanup_action=status 只读核实；仅当状态为 pending 且 cleanupRemainingCount 大于 0 时可用 retry。unknown 或 failed 不满足重试门禁，不能重试删页。不会关闭用户自己的页面。'),
):
    properties = {'task_id': _text()}
    if suffix == 'close':
        properties['cleanup_action'] = {'type': 'string', 'enum': ['status', 'retry']}
        properties['keep_tabs'] = {'type': 'boolean'}
    TOOL_SCHEMAS['browser_shared_' + suffix] = {'description': description, 'parameters': _object(properties, ('task_id',))}
TOOL_SCHEMAS['browser_shared_get']['description'] += ' 任务就绪时把本会话绑定到它（同一会话只绑定一个任务），供脚本与官方 browser_* 工具使用；结果见 sessionBinding。'
TOOL_SCHEMAS['browser_shared_get']['parameters']['properties'].update({
    'until': {'type': 'string', 'enum': ['resumed']},
    'timeout_s': {'type': 'integer', 'minimum': 1, 'maximum': 3600},
    'include_log': {'type': 'boolean'},
    'log_limit': {'type': 'integer', 'minimum': 1, 'maximum': 100},
})
TOOL_SCHEMAS['browser_shared_get']['description'] += ' 接管暂停时设置 until=resumed 等待，默认最多 600 秒；恢复后先重新读页面。排查时设置 include_log=true、log_limit=N 获取最近步骤。'


_CLEANUP_REASONS = frozenset({
    'legacy_unverified', 'release_in_progress', 'browser_offline', 'extension_unreported',
    'extension_timeout', 'extension_disconnected', 'workspace_unknown', 'too_many_pending',
    'transport_error', 'extension_error', 'invalid_response', 'late_result', 'no_journal',
    'preserved', 'cleanup_uncertain', 'cleanup_timeout', 'ownership_unknown',
    'remaining_owned_tabs', 'preserved_tabs', 'cleanup_failed', 'verified_complete', 'handed_to_user',
})
_CLEANUP_STATES = frozenset({'succeeded', 'pending', 'unknown', 'failed'})


def _public(value, raw=None):
    # Shared credential filter, with task guidance only at the envelope level;
    # a nested API business row with state=pending_approval is not a task.
    result = _runtime._base._strip_owner(value)
    rows = result if isinstance(result, list) else [result]
    source_rows = raw if isinstance(raw, list) else [raw]
    for index, row in enumerate(rows):
        source = source_rows[index] if index < len(source_rows) else None
        if isinstance(row, dict) and isinstance(source, dict) and row.get('id') == source.get('id') and 'state' in row:
            state = source.get('cleanupState')
            if isinstance(state, str) and state in _CLEANUP_STATES:
                row['cleanupState'] = state
            reason = source.get('cleanupReason')
            if isinstance(reason, str) and reason in _CLEANUP_REASONS:
                row['cleanupReason'] = reason
            error = source.get('cleanupError')
            if isinstance(error, dict) and isinstance(error.get('code'), str) and error['code'] in _CLEANUP_REASONS:
                row['cleanupError'] = {'code': error['code']}
            for field in ('cleanupRemainingCount', 'cleanupPreservedCount', 'cleanupUnknownCount', 'spawnedTabCount'):
                count = source.get(field)
                if type(count) is int and 0 <= count <= 256:
                    row[field] = count
        if isinstance(row, dict) and row.get('state') == 'authorizing':
            row['message'] = '正在自动安装工作页授权，无需逐个批准；请用get查询ready状态后再执行，不要重复创建任务。'
        if isinstance(row, dict) and row.get('state') == 'pending_approval':
            row['message'] = '浏览器扩展正在自动安装任务，请先用get查询ready状态，不要重复创建；就绪后用new_tab创建工作页。智能审批模式下，高风险动作仍需逐项批准。'
    return result


def _validate_value(spec, value):
    kind = spec['type']
    if kind == 'string':
        if not isinstance(value, str) or not spec.get('minLength', 0) <= len(value) <= spec.get('maxLength', 100000):
            raise ValueError('字符串参数无效')
        if 'enum' in spec and value not in spec['enum']:
            raise ValueError('不支持的浏览器动作')
    elif kind == 'integer':
        if type(value) is not int or value < spec.get('minimum', -(2 ** 53)) or value > spec.get('maximum', 2 ** 53):
            raise ValueError('整数参数无效')
    elif kind == 'number':
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError('坐标必须是有限数字')
    elif kind == 'boolean':
        if type(value) is not bool:
            raise ValueError('布尔参数无效')
    elif kind == 'object':
        if not isinstance(value, dict):
            raise ValueError('对象参数无效')
        properties = spec.get('properties', {})
        if set(value) - set(properties) or set(spec.get('required', ())) - set(value):
            raise ValueError('对象参数缺少字段或包含未知字段')
        for key, item in value.items():
            _validate_value(properties[key], item)
    elif kind == 'array':
        if not isinstance(value, list) or not spec.get('minItems', 0) <= len(value) <= spec.get('maxItems', 100000):
            raise ValueError('列表参数无效')
        for item in value:
            _validate_value(spec['items'], item)


def _validate_field(key, value, spec, public):
    from urllib.parse import urlsplit
    kind = spec['type']
    if kind == 'array' and key == 'fields':
        import re
        if not isinstance(value, list) or not 1 <= len(value) <= 16:
            raise ValueError('API范围或字段列表无效')
        for entry in value:
            if not isinstance(entry, str): raise ValueError('API参数无效')
            if key == 'fields':
                if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', entry): raise ValueError('字段名无效')
            else:
                u = urlsplit(entry)
                if len(entry) > 4096 or u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.fragment:
                    raise ValueError('API网址无效')
                u.port
                if f'{u.scheme}://{u.netloc}' not in public.get('allowed_origins', []): raise ValueError('API须属于已申请来源')
        return
    if key == 'options' and public.get('action') == 'page.parse':
        if not isinstance(value, dict) or len(json.dumps(value, allow_nan=False)) > 100000:
            raise ValueError('页面解析参数无效')
        return
    if key == 'arguments':
        if len(json.dumps(value, allow_nan=False)) > 100000:
            raise ValueError('页面函数参数超限')
        return
    if key == 'values' and public.get('action') == 'ref_select_option':
        # 中文注释：index 使用零基整数；value 和 Unicode 标签使用原样字符串，类型不能混用。
        by = public.get('by')
        if not isinstance(value, list) or len(value) > 100:
            raise ValueError('选项参数无效')
        if by == 'index':
            if any(type(item) is not int or item < 0 or item > 2 ** 53 - 1 for item in value):
                raise ValueError('选项索引无效')
        elif any(not isinstance(item, str) or len(item) > 1000 for item in value):
            raise ValueError('选项文本无效')
        if len(set(value)) != len(value):
            raise ValueError('选项参数重复')
        return
    if key == 'cdp_params':
        if not isinstance(value, dict) or len(json.dumps(value, ensure_ascii=False)) > 1_000_000:
            raise ValueError('CDP 参数必须是对象')
        return
    if kind == 'array' and key == 'allowed_origins':
        if not isinstance(value, list) or not 1 <= len(value) <= 64:
            raise ValueError('必须明确指定允许的网站来源')
        for origin in value:
            if not isinstance(origin, str) or not 1 <= len(origin) <= 2048:
                raise ValueError('网站来源无效')
            parsed = urlsplit(origin)
            if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username
                    or parsed.password or parsed.path or parsed.query or parsed.fragment or '*' in origin):
                raise ValueError('必须使用精确http(s)来源，不得包含路径或凭证')
            parsed.port  # Reject malformed ports.
        return
    _validate_value(spec, value)


class ArgumentFieldsError(ValueError):
    # 中文注释：参数错误仅报告字段名，禁止回显值或底层异常文本。
    def __init__(self, code, fields):
        self.code, self.fields = code, sorted(fields)
        super().__init__(code)


def _validate(tool_name, args):
    from urllib.parse import urlsplit
    schema = TOOL_SCHEMAS[tool_name]['parameters']
    public = {k: v for k, v in args.items() if k != _runtime.OWNER_LEASE_ARG}
    missing = set(schema['required']) - set(public)
    if missing:
        raise ArgumentFieldsError('missing_fields', missing)
    extra = set(public) - set(schema['properties'])
    if extra:
        raise ArgumentFieldsError('invalid_fields', extra)
    for key, value in public.items():
        try:
            _validate_field(key, value, schema['properties'][key], public)
        except (ValueError, TypeError, OverflowError):
            raise ArgumentFieldsError('invalid_fields', [key]) from None
    if tool_name == 'browser_shared_get' and 'timeout_s' in public and public.get('until') != 'resumed':
        raise ArgumentFieldsError('invalid_fields', ['timeout_s'])
    if tool_name == 'browser_shared_get' and 'log_limit' in public and public.get('include_log') is not True:
        raise ArgumentFieldsError('invalid_fields', ['log_limit'])
    if tool_name == 'browser_shared_cookie_mirror':
        # 中文注释：动作只接受各自必需的参数，模型不能传入批准或 Cookie 载荷。
        action = public['action']
        required = {'list_sites': {'source'}, 'request_mirror': {'source', 'target', 'sites'}, 'status': {'transfer_id'}}[action]
        allowed = required | {'action'} | ({'options'} if action == 'request_mirror' else set())
        if required - set(public):
            raise ArgumentFieldsError('missing_fields', required - set(public))
        if set(public) - allowed:
            raise ArgumentFieldsError('invalid_fields', set(public) - allowed)
    if tool_name == 'browser_shared_run':
        action = public['action']
        fields = {
            'tabs': (), 'new_tab': ('url',), 'navigate': ('url',), 'snapshot': (),
            'click': ('selector',), 'fill': ('selector', 'text'), 'press': ('selector', 'key'),
            'screenshot': (), 'api_request': ('url', 'fields'), 'page.parse': (), 'semantic_snapshot': (), 'frame_catalog': (),
            'ref_click': ('binding', 'snapshot_id', 'ref'),
            'ref_fill': ('binding', 'snapshot_id', 'ref', 'text'),
            # 中文注释：按键必须绑定最新语义引用，不能只靠网页选择器重定位。
            'ref_press': ('binding', 'snapshot_id', 'ref', 'key'),
            'ref_set_checked': ('binding', 'snapshot_id', 'ref', 'checked'),
            'ref_select_option': ('binding', 'snapshot_id', 'ref', 'by', 'values'),
            'files.upload': ('selector',),
            'interaction.capture': (),
            'interaction.bounds': ('screenshot_id', 'selector'),
            'interaction.click': ('screenshot_id', 'point', 'expected_ref'),
            'interaction.drag_coordinates': ('screenshot_id', 'from', 'to'),
            'interaction.drag_elements': ('screenshot_id', 'source', 'target'),
            'scroll': ('direction',), 'back': (),
            'js.evaluate': ('expression',), 'cdp.send': ('method',), 'cdp.events': (),
            'images': (), 'console': (), 'dialog': ('accept',),
        }
        optional = {
            'click': {'clickMode'}, 'ref_click': {'clickMode', 'frame_token'},
            'ref_fill': {'frame_token'}, 'ref_press': {'frame_token'}, 'ref_set_checked': {'frame_token'},
            'ref_select_option': {'frame_token'},
            'scroll': {'binding', 'snapshot_id', 'ref', 'frame_token'},
            'files.upload': {'artifact_ids', 'paths'}, 'navigate': {'summary'},
            'api_request': {'http_method'}, 'page.parse': {'options'}, 'semantic_snapshot': {'options'},
            'interaction.drag_coordinates': {'mode', 'steps'},
            'interaction.drag_elements': {'mode', 'steps'},
            'js.evaluate': {'world', 'await_promise', 'timeout_ms', 'frame_token', 'arguments'},
            'cdp.send': {'cdp_params', 'frame_token', 'target_id', 'timeout_ms'}, 'cdp.events': {'max'},
            'console': {'clear'}, 'dialog': {'prompt_text'},
        }
        required = fields[action]
        allowed = {'task_id', 'request_id', 'action'} | set(required) | optional.get(action, set())
        if action not in ('tabs', 'new_tab'):
            required += ('tab_id',)
            allowed.add('tab_id')
        if set(public) - allowed:
            raise ArgumentFieldsError('invalid_fields', set(public) - allowed)
        if set(required) - set(public):
            raise ArgumentFieldsError('missing_fields', set(required) - set(public))
        if action == 'cdp.send' and 'target_id' in public and 'frame_token' in public:
            raise ArgumentFieldsError('invalid_fields', ['target_id', 'frame_token'])
        if action == 'interaction.drag_coordinates' and public.get('mode', 'pointer') != 'pointer':
            raise ArgumentFieldsError('invalid_fields', ['mode'])
        if 'clickMode' in public and public['clickMode'] not in (
                {'open_link_in_task_tab'} if action == 'click' else
                {'open_link_in_task_tab', 'pointer'} if action == 'ref_click' else set()):
            raise ArgumentFieldsError('invalid_fields', ['clickMode'])


def _revoke_bound_task(bridge, session_id, task_id):
    # 中文注释：取消只撤销指定任务，不影响同会话其他网站。
    bridge.unbind(session_id, task_id=task_id)


def make_tool_handler(tool_name, profile_runtime, *, host_bridge=None, backend_check=None):
    if tool_name not in _METHODS:
        raise ValueError('unknown shared browser tool')

    def handler(args, *, session_id=None, **_):
        try:
            lease = profile_runtime.authority.consume(tool_name, args, session_id=session_id)
            try:
                _validate(tool_name, args)
            except ArgumentFieldsError as exc:
                return json.dumps({'error': '浏览器动作参数不符合契约', 'code': exc.code,
                                   'fields': exc.fields, 'retryable': False, 'outcome_unknown': False}, ensure_ascii=False)
            params = {'owner': lease.owner}
            if tool_name in ('browser_shared_health', 'browser_shared_browsers'):
                params = {}
            if tool_name == 'browser_shared_get' and args.get('include_log') is True:
                params['includeLog'] = True
                params['logLimit'] = args.get('log_limit', 20)
            mapping = {'title': 'title', 'instance_id': 'instanceId', 'allowed_origins': 'allowedOrigins',
                       'task_id': 'taskId', 'action': 'action', 'tab_id': 'tabId', 'url': 'url',
                       'selector': 'selector', 'text': 'text', 'key': 'key',
                       'clickMode': 'clickMode',
                       'fields': 'fields', 'http_method': 'httpMethod',
                       'options': 'options', 'binding': 'binding', 'snapshot_id': 'snapshotId',
                       'ref': 'ref', 'checked': 'checked', 'frame_token': 'frameToken', 'target_id': 'targetId',
                       'by': 'by', 'values': 'values',
                       'artifact_ids': 'artifactIds', 'paths': 'paths',
                       'screenshot_id': 'screenshotId', 'point': 'point',
                       'expected_ref': 'expectedRef', 'from': 'from', 'to': 'to',
                       'source': 'source', 'target': 'target', 'mode': 'mode', 'steps': 'steps',
                       'direction': 'direction',
                       'arguments': 'arguments', 'expression': 'expression', 'world': 'world', 'await_promise': 'awaitPromise',
                       'timeout_ms': 'timeoutMs', 'method': 'method', 'cdp_params': 'params', 'max': 'max',
                       'sites': 'sites', 'transfer_id': 'transferId',
                       'clear': 'clear', 'accept': 'accept', 'prompt_text': 'promptText'}
            for key, wire in mapping.items():
                if key in args:
                    params[wire] = args[key]
            if isinstance(params.get('paths'), list):
                params['paths'] = [os.path.abspath(os.path.expanduser(item)) if isinstance(item, str) else item
                                   for item in params['paths']]
            if tool_name == 'browser_shared_run':
                params['requestId'] = args.get('request_id') or lease.tool_call_id
            if tool_name == 'browser_shared_get' and args.get('until') == 'resumed':
                timeout = args.get('timeout_s', 600)
                deadline = time.monotonic() + timeout
                while True:
                    observed = profile_runtime.call('shared.get', params)
                    if observed.get('state') != 'paused':
                        break
                    if time.monotonic() >= deadline:
                        return json.dumps({'code': 'task_paused', 'error': '接管等待超时；任务仍暂停，可再次调用 browser_shared_get 等待。',
                                           'retryable': False, 'outcome_unknown': False}, ensure_ascii=False)
                    time.sleep(min(0.5, max(0, deadline - time.monotonic())))
            method = _METHODS[tool_name]
            if tool_name == 'browser_shared_downloads':
                method = _DOWNLOAD_METHODS[args.get('action', 'list')]
                params = {'owner': lease.owner, 'taskId': args['task_id']}
                if method != 'shared.downloads':
                    if not args.get('download_id'):
                        return json.dumps({'error': '需要 download_id', 'code': 'invalid_arguments', 'retryable': False},
                                          ensure_ascii=False)
                    params['downloadId'] = args['download_id']
            if tool_name == 'browser_shared_close' and 'cleanup_action' in args:
                method = 'shared.cleanup_' + args['cleanup_action']
            elif tool_name == 'browser_shared_close' and args.get('keep_tabs') is True:
                method = 'shared.handoff'
                params['keepTabs'] = True
            if host_bridge and (tool_name in ('browser_shared_cancel', 'browser_shared_close', 'browser_shared_resume')
                                and method not in ('shared.cleanup_status', 'shared.cleanup_retry')):
                _revoke_bound_task(host_bridge, session_id, args['task_id'])
            result = profile_runtime.call(method, params)
            projected = _runtime._base._project_tool_result(tool_name, args, result)
            public = _public(projected, raw=result if tool_name in {
                'browser_shared_create', 'browser_shared_get', 'browser_shared_list',
                'browser_shared_cancel', 'browser_shared_close', 'browser_shared_resume'} else None)
            if (tool_name == 'browser_shared_run' and args.get('action') == 'navigate'
                    and args.get('summary') is not False and isinstance(public, dict)
                    and type(public.get('tabId')) is int):
                # 中文注释：导航成功后沿用 open 的语义摘要，读取失败不改写已确认的导航回执。
                try:
                    summary_module = runtime_module().load_module(Path(__file__).with_name('open_tool.py'),
                                                                   'hermes_browser_open_summary_')
                    public['summary'] = summary_module._summary(profile_runtime, lease.owner, args['task_id'],
                                                                 public['tabId'], params['requestId'], public.get('url', args['url']))
                except Exception:
                    public['summary'] = None
            if host_bridge and tool_name in ('browser_shared_create', 'browser_shared_get', 'browser_shared_resume'):
                if isinstance(result, dict) and result.get('state') == 'ready' and result.get('id') == (
                        args.get('task_id') if tool_name != 'browser_shared_create' else result.get('id')):
                    try:
                        if backend_check is not None:
                            backend_check()
                        # bind performs its own owner-scoped shared.get and connected-instance
                        # readback; neither the model nor projected output supplies identity.
                        host_bridge.bind(session_id, owner=lease.owner, task_id=result['id'])
                        public['sessionBinding'] = 'ready'
                    except Exception:
                        public['sessionBinding'] = 'denied'
                        public['sessionBindingError'] = '会话未绑定到此任务：任务身份、授权或会话冲突；请先核实并结束原绑定。'
                elif isinstance(public, dict):
                    public['sessionBinding'] = 'awaiting_authorization'
            return json.dumps(public, ensure_ascii=False)
        except _runtime.OwnerLeaseError:
            return json.dumps({'error': '浏览器任务身份验证失败，已拒绝操作', 'code': 'owner_denied', 'retryable': False}, ensure_ascii=False)
        except Exception as exc:
            # Keep the established error/code envelope; expose only allowlisted
            # classifications, never extension text that may contain page data.
            code = str(getattr(exc, 'code', ''))
            data = getattr(exc, 'data', None)
            data = data if isinstance(data, dict) else {}
            if tool_name == 'browser_shared_cookie_mirror':
                # 中文注释：镜像错误独立投影，不能混入页面诊断字符串；状态失联也不能重发复制。
                summary = _runtime._base._project_tool_result(tool_name, args,
                    {key: data[key] for key in ('count', 'success', 'failed', 'matched', 'missing', 'cleared', 'clearFailed', 'reasons', 'sites', 'reason') if key in data})
                return json.dumps({**summary, 'code': 'cookie_mirror_denied', 'bridgeCode': 'cookie_mirror_denied',
                    'error': 'Cookie 镜像请求不可用或已过期，请在扩展核实；不要重复执行。',
                    'retryable': False, 'outcome_unknown': args.get('action') != 'list_sites'}, ensure_ascii=False)
            messages = {
                'cookie_mirror_denied': 'Cookie 镜像请求不可用或已过期，请在扩展核实；不要重复执行。',
                'approval_denied': '用户拒绝了这次操作，未执行。',
                'user_input_declined': '用户选择不填写该敏感字段，未执行。',
                'approval_expired': '这次确认已过期，未执行；不会自动重试。',
                'approval_revoked': '这次确认已撤销；如操作已开始，请先检查页面结果，不要自动重试。',
                'request_outcome_unavailable': '结果无法确认，请检查页面状态；禁止自动重试。',
                'request_id_conflict': '请求编号已绑定其他参数，拒绝修改或重放。',
                'foreign_tab': '标签页不属于本任务。',
                'forbidden': '任务不属于当前会话。',
                'api_not_approved': '浏览器外接口读取需要单独批准登录凭据使用。',
                'origin_denied': '网址不在用户批准范围内；同站用 goto_url，新站用 browser_shared_open。',
                'tab_out_of_scope': '该工作页已离开授权网站（任务与标签组仍保留，未执行）。请用 navigate 把它导航回授权网站后继续；需要新网站时再向用户申请。',
                'redirected_out_of_scope': '页面跳转到任务范围外的网站（finalOrigin），未在该页继续执行；需要该网站时用 browser_shared_open 以该来源新开任务。',
                'task_closed': '任务已结束；请重新 browser_shared_open。',
                'instance_unavailable': '浏览器扩展未连接；请检查连接后重新读取任务状态。',
                'invalid_state': '任务未就绪；请查看状态。若已结束，请重新 browser_shared_open。',
                'task_preparing': '任务授权正在准备或等待浏览器批准；请先查询任务状态，ready 后重新调用。本次未执行。',
                # 中文注释：截图超时不返回图片，也不建议自动重试。
                'screenshot_timeout': '截图超时，未返回截图；请核对页面状态后再操作。',
                'capture_sensitive_blocked': '敏感字段遮罩失败；请隐藏该字段或让用户手动截图。',
                'capture_frame_uninspectable': '框架遮罩位置无法确认；请移开该框架或让用户手动截图。',
                'task_paused': '用户正在接管浏览器页面。请等待用户退出接管，再继续此任务。',
                'execution_denied': '浏览器拒绝执行，原因未分类；请查看任务和扩展状态，先读取页面核实结果。不要自动重试。',
                'outcome_unknown': '执行结果不确定，请先检查页面；禁止自动重试。',
                'extension_timeout': '浏览器响应超时，结果不确定；禁止自动重试。',
                'scroll_timeout': '滚动派发未在短期限内返回；先读取原标签页面确认位置，再决定是否继续。',
                'extension_disconnected': '扩展连接已中断；请检查连接，读取任务状态后再继续。结果不确定时禁止自动重试。',
                'page_not_ready': '页面仍在加载或刚被替换；稍等几秒后在同一标签页重新读取即可，不要重新打开或新建标签页。',
                'document_changed': '页面已更改，请重新读取后再执行。',
                'site_changed': '读取期间页面切换了网站，结果未返回；请用新 request_id 重新申请目标网站读取。',
                'stale_reference': '页面引用已失效，请重新读取。',
                # 中文注释：分页游标失效需要重新解析页面，保留类型供调用者区分连接与授权错误。
                'parse_cursor_stale': '页面或解析选项已变化，分页游标已失效；请不带旧游标重新读取。',
                'parse_budget_too_small': '解析结果超过预算；请增大 budget 或缩小 sections。未返回结果。',
                'permission_denied': '操作未获授权。',
                'target_unavailable': '目标不可用；请重新读取页面，若位于 iframe 则使用 frame token。',
                'invalid_target_state': '控件状态无法按要求改变（状态未知或参数无效）；未派发。',
                'radio_cannot_uncheck': '单选框不能直接取消选中；请选择同组的另一项。未派发。',
                'invalid_select_option': '选项参数对该控件无效；未派发。',
                'select_option_missing': '指定的选项不存在；请重新读取可选项。未派发。',
                'select_option_ambiguous': '有多个选项同名；请改用唯一的 value。未派发。',
                'select_option_disabled': '指定的选项已禁用；未派发。',
                'target_occluded': '目标被其他元素遮挡，未点击；等遮挡消失或先处理遮挡层后重新读取。',
                # 中文注释：细分拒绝码使用固定文案，不返回页面异常文本。
                'target_disabled': '目标已禁用；未派发。',
                'target_hidden': '目标不可见；未派发。',
                'target_zero_size': '目标没有可操作尺寸；未派发。',
                'target_out_of_viewport': '目标不在视口内；若浮层固定在屏幕外，先关闭或重新打开浮层，也可改用键盘选择。未派发。',
                'reference_target_missing': '旧引用在当前文档没有唯一目标；请重新读取。',
                'reference_target_ambiguous': '旧引用匹配多个目标；请缩小范围后重新读取。',
                'closed_shadow_unavailable': '封闭 Shadow DOM 无法访问。',
                'cross_origin_frame_unavailable': '该跨域子框架当前无法操作。',
                'background_pointer_unavailable': '后台标签页无法确认拖动送达；未派发，请保持工作页可见后再操作。',
                'target_unstable': '目标位置一直在变化（动画或重排），未派发点击；稍后重新读取再试。',
                'unsupported_frame_transform': '目标所在 frame 有旋转或倾斜变换，暂不支持该动作；未派发。',
                'target_not_owned': '指定的 CDP 目标不属于当前任务工作页；未派发。',
                'file_path_unavailable': '本地文件不存在、不是普通文件或超过 100 MiB；当前未派发。',
                'artifact_unavailable': '用户登记的文件已失效或与当前任务不符；当前未派发。',
                'artifact_path_denied': '任务私有文件路径不符合当前任务范围；未派发。',
                'artifact_origin_denied': '目标页面来源不在文件选择范围；未派发。',
                'file_input_not_unique': '文件选择器没有唯一匹配输入框；未派发。',
                'not_file_input': '目标不是兼容的文件输入框；未派发。',
                # 中文注释：并发冲突和同步状态单独说明，不能落入通用错误。
                'needs_sync': '任务状态需要重新核对；请查询任务状态并确认浏览器工作页。',
                'task_busy': '任务标签存在并发冲突；请核对本次结果后再继续。',
                'workspace_unknown': '工作页状态不确定，请先核实。',
                # 中文注释：撤权是旧任务终态，重新开启访问后也必须创建新任务。
                'browser_access_revoked': '用户已撤销浏览器访问；请等待重新开启后创建新任务，旧任务不能继续。',
                'download_not_found': '没有找到本任务的这项下载。',
                'download_not_complete': '下载尚未完成或已中断，不能领取；请先用 list 查看状态。',
                'download_changed': '下载文件已变化或缺失，拒绝领取。',
                'download_missing': '下载文件已不在暂存目录，无法领取。',
                'download_path_denied': '下载文件不在任务暂存目录内，拒绝领取。',
                'download_invalid': '下载编号无效。',
                'browser_access_required': '任务访问已失效；请核对任务状态。未派发。',
                'frame_not_supported': '当前 frame 不支持主上下文执行。未派发。',
                'credential_mode_conflict': '此页面发生过凭据填写，不能执行任意 JS/CDP；请在新的任务页中操作。',
                'cdp_method_denied': 'CDP 方法名称无效；未派发。',
                'js_timeout': 'JavaScript 超时；已终止后续执行，但已发生的页面副作用无法回滚。先读取页面核实，不要自动重试。',
                'cdp_error': '浏览器返回了 CDP 协议错误。',
                'no_dialog': '当前任务页没有打开的 JS 对话框。',
                'dialog_open': '页面有 JS 对话框阻塞，请先用 dialog 动作接受或关闭它。未派发。',
                'reconcile_required': '仅当最近一次 close cleanup_action=status 返回 pending 且 cleanupRemainingCount 大于 0，才可显式 retry；unknown 或 failed 时禁止重试删页。',
            }
            # 只展示扩展定义的高亮阶段错误码，不展示网页异常内容。
            if code.startswith('interaction_highlight_') or code in {
                    'overlay_injection_failed', 'overlay_scope_stale', 'overlay_frame_changed'}:
                messages[code] = '页面高亮或目标确认失败；先核查页面状态，不要自动重试。'
            # 中文注释：滚动的未知结果保留桥接判断，不能按只读动作改写为确定失败。
            read_only = tool_name in {'browser_shared_health', 'browser_shared_browsers', 'browser_shared_get', 'browser_shared_list', 'browser_shared_artifacts'} or (
                tool_name == 'browser_shared_downloads' and args.get('action', 'list') != 'cancel') or (
                tool_name == 'browser_shared_close' and args.get('cleanup_action') == 'status') or (
                tool_name == 'browser_shared_run' and args.get('action') in {
                    'tabs', 'snapshot', 'page.parse', 'semantic_snapshot', 'frame_catalog', 'screenshot', 'api_request',
                    'interaction.capture', 'interaction.bounds', 'cdp.events', 'images', 'console'})
            # user_input_declined: a manual-input request is never dispatched to the page.
            safe_before_dispatch = data.get('outcomeUnknown') is False and code in {
                'stale_reference', 'stale_frame', 'target_unavailable', 'invalid_select_option',
                'invalid_target_state', 'document_changed', 'site_changed', 'cdp_method_denied', 'invalid_params',
                'task_busy', 'target_not_owned', 'permission_denied', 'no_dialog', 'dialog_open', 'invalid_state', 'task_closed', 'instance_unavailable', 'task_preparing', 'browser_access_revoked',
                'target_occluded', 'target_unstable', 'unsupported_frame_transform', 'background_pointer_unavailable', 'radio_cannot_uncheck',
                'target_disabled', 'target_hidden', 'target_zero_size', 'target_out_of_viewport',
                'reference_target_missing', 'reference_target_ambiguous', 'closed_shadow_unavailable', 'cross_origin_frame_unavailable',
                'select_option_missing', 'select_option_ambiguous', 'select_option_disabled'} or (
                data.get('outcomeUnknown') is False and code.startswith('interaction_highlight_'))
            known_safe = code in {'forbidden', 'request_id_conflict', 'reconcile_required', 'user_input_declined', 'task_paused',
                                  'tab_out_of_scope', 'redirected_out_of_scope', 'origin_denied', 'invalid_url', 'download_not_found', 'download_not_owned', 'browser_access_required',
                                  'frame_not_supported', 'credential_mode_conflict',
                                  'artifact_unavailable',
                                  'file_path_unavailable', 'artifact_path_denied', 'artifact_origin_denied',
                                  'file_input_not_unique', 'not_file_input'} or safe_before_dispatch
            unknown = False if read_only else (data.get('outcomeUnknown') if type(data.get('outcomeUnknown')) is bool else not known_safe)
            # Never allow metadata about a failed write to declare certainty.
            if not read_only and not known_safe:
                unknown = True
            result = {'error': messages.get(code, '共享浏览器操作失败；请检查浏览器连接和用户批准状态。结果不确定时不要自动重试。'),
                      'code': 'bridge_error', 'retryable': bool(data.get('retryable') is True and code != 'task_paused' and (read_only or code == 'task_preparing') and not unknown),
                      'outcome_unknown': unknown}
            # 中文注释：协议层固定码必须始终传给模型，未知码仍有稳定的分类入口。
            result['bridgeCode'] = code or 'bridge_error'
            # 中文注释：只转发 client 已校验的固定诊断字段。
            for key in ('currentOrigin', 'scopeHint', 'stage', 'reasonCode'):
                if key in data:
                    result[key] = data[key]
            # 中文注释：跨站跳转只转发 client 已校验的来源，不含路径或查询。
            if code == 'redirected_out_of_scope' and isinstance(data.get('finalOrigin'), str):
                result['finalOrigin'] = data['finalOrigin']
                result['outcome_unknown'] = False
            # 中文注释：确定性拒绝保留细分码及最小摘要，未知结果仍不暴露页面信息。
            if not unknown and code in {'target_occluded', 'target_disabled', 'target_hidden', 'target_zero_size',
                                        'target_out_of_viewport', 'reference_target_missing', 'reference_target_ambiguous',
                                        'closed_shadow_unavailable', 'cross_origin_frame_unavailable',
                                        'capture_sensitive_blocked', 'capture_frame_uninspectable', 'element_timeout'}:
                result['code'] = code
                if code in {'reference_target_missing', 'reference_target_ambiguous', 'element_timeout'} and isinstance(data.get('candidates'), list):
                    result['candidates'] = [{'role': row['role'][:40], 'name': row['name'][:80]}
                                            for row in data['candidates'][:5] if isinstance(row, dict)
                                            and isinstance(row.get('role'), str) and isinstance(row.get('name'), str)]
                if code == 'target_occluded':
                    obstruction = data.get('obstruction')
                    if isinstance(obstruction, dict) and isinstance(obstruction.get('role'), str) and isinstance(obstruction.get('name'), str):
                        result['obstruction'] = {'role': obstruction['role'][:40], 'name': obstruction['name'][:80]}
                        button = obstruction.get('closeButton')
                        binding = button.get('binding') if isinstance(button, dict) else None
                        if isinstance(binding, dict) and all(isinstance(binding.get(key), str) for key in ('taskId', 'documentId', 'leaseId')) and all(isinstance(button.get(key), str) for key in ('snapshotId', 'ref', 'name')):
                            result['obstruction']['closeButton'] = {'binding': {key: binding[key] for key in ('taskId', 'documentId', 'leaseId')}, 'snapshotId': button['snapshotId'], 'ref': button['ref'], 'role': 'button', 'name': button['name'][:80]}
            return json.dumps(result, ensure_ascii=False)
    return handler


def register_native_context(ctx, profile_runtime, *, cleanup=None, host_bridge=None, backend_check=None):
    # 中文注释：CLI 完成后退出还会 finalize；已有完成信号时保留 daemon 宽限，不被进程退出提前关闭。
    completed_sessions = set()
    def record_activity(tool_name, args, **identity):
        decision = profile_runtime.authority.pre_tool_call(tool_name, args, **identity)
        # 中文注释：包含健康、reference、doctor、open、script 等无页面 RPC 的工具；只有可信租约才能取消计时。
        if tool_name.startswith('browser_shared_') and isinstance(decision, dict) and decision.get('action') == 'modify':
            completed_sessions.discard(identity['session_id'])
            try:
                params = {'owner': profile_runtime.authority.owner_for_session(identity['session_id'])}
                if isinstance(args, dict) and isinstance(args.get('task_id'), str) and args['task_id'].strip():
                    params['taskId'] = args['task_id']
                profile_runtime.call('shared.activity', params)
            except Exception:
                logging.getLogger('browser-link').warning('浏览器活动信号未送达，无法确认取消空闲计时。')
        return decision
    ctx.register_hook('pre_tool_call', record_activity)
    def finalize_session(*, session_id=None, **_):
        # 中文注释：只接受宿主结束的会话，先撤销本地租约和脚本绑定，再关闭该 owner 的全部任务。
        if not isinstance(session_id, str) or not session_id.strip():
            return
        authority = profile_runtime.authority
        owner = authority.owner_for_session(session_id)
        if owner not in authority.known_owners():
            return
        with authority._lock:
            for token, lease in list(authority._leases.items()):
                if lease.owner == owner:
                    authority._leases.pop(token, None)
        if host_bridge is not None:
            host_bridge.unbind(session_id)
        tasks = profile_runtime.call('shared.list', {'owner': owner})
        pending = [task for task in tasks if task.get('state') not in {'closed', 'cancelled'}]
        def close_task(task):
            try:
                result = profile_runtime.call('shared.handoff', {'owner': owner, 'taskId': task['id']})
                return result.get('cleanupState') == 'succeeded'
            except Exception:
                # 中文注释：关闭回执丢失不自动重放，继续撤销其他任务并明确记录未确认清理。
                return False
        if pending:
            with ThreadPoolExecutor(max_workers=min(4, len(pending))) as pool:
                complete = all(list(pool.map(close_task, pending)))
            if not complete:
                logging.getLogger('browser-link').warning('会话浏览器任务已请求关闭，但部分清理结果未确认，请核对任务清理状态。')

    def finalize_subagent(*, child_session_id=None, **_):
        # 中文注释：子代理结束只使用 child_session_id，绝不能把父会话作为清理对象。
        return finalize_session(session_id=child_session_id)

    def finalize_unfinished(*, session_id=None, **kwargs):
        if session_id not in completed_sessions:
            return finalize_session(session_id=session_id, **kwargs)

    ctx.register_hook('on_session_finalize', finalize_unfinished)
    ctx.register_hook('subagent_stop', finalize_subagent)
    def end_turn(*, session_id=None, completed=False, failed=False, interrupted=False, **_):
        # 中文注释：每轮完成只向常驻 daemon 发信号；插件卸载或 CLI 退出不会丢失宽限截止时间。
        if failed is True or interrupted is True:
            completed_sessions.discard(session_id)
            return finalize_session(session_id=session_id)
        if completed is not True or not isinstance(session_id, str) or not session_id.strip():
            return
        owner = profile_runtime.authority.owner_for_session(session_id)
        if owner in profile_runtime.authority.known_owners():
            profile_runtime.call('shared.session_end', {'owner': owner})
            completed_sessions.add(session_id)

    def stop_loop(*, session_key=None, **_):
        # 中文注释：停止事件只带路由 key，映射失败不扩大清理范围，不输出可能含用户信息的 key。
        session_id = profile_runtime.session_for_key(session_key)
        if session_id is None:
            logging.getLogger('browser-link').warning('停止事件的 session_key 无法映射到本 profile 已知会话，未关闭浏览器任务。')
            return
        return finalize_session(session_id=session_id)

    ctx.register_hook('on_session_end', end_turn)
    ctx.register_hook('agent_loop_stopped', stop_loop)
    for name in TOOL_NAMES:
        schema = TOOL_SCHEMAS[name]
        ctx.register_tool(name=name, toolset='browser-link', schema=schema,
                          handler=make_tool_handler(name, profile_runtime, host_bridge=host_bridge,
                                                    backend_check=backend_check),
                          description=schema['description'], emoji='🌐')
    ctx.on_unload(cleanup or profile_runtime.close)
