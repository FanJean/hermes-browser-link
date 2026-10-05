"""Offline result-boundary regressions; only synthetic credentials, no browser.

This boundary is structured-data minimization, NOT arbitrary-text/image DLP.
Unlabelled secrets in page prose, URLs or pixels require producer-side controls.
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
CANARY = 'SYNTHETIC_CREDENTIAL_CANARY'


def load(name):
    key = 'privacy_test_' + name
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, ROOT / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        spec.loader.exec_module(module)
    return sys.modules[key]


class ResultPrivacyTests(unittest.TestCase):
    def test_cookie_mirror_metadata_tool_projection_and_fixed_errors(self):
        # 中文注释：恶意附加值、载荷、错误文本和原因字段不能越过新工具结果边界。
        secret = '_'.join(('SECRET', 'COOKIE', 'VALUE', 'xyz'))
        raw = {'status': 'completed', 'count': 1, 'success': 1, 'failed': 0, 'matched': 1, 'missing': 0,
            'cookies': [secret], 'cookie': secret, 'value': secret, 'errorText': secret,
            'source': secret, 'target': secret, 'transferId': secret,
            'sites': [{'site': 'example.com', 'count': 1, 'cookie': secret, 'value': secret,
                       'reasons': {secret: 1, 'write_failed': 0}}, {'site': secret, 'count': secret}]}
        for action, args in [('list_sites', {'source': 's'}), ('request_mirror', {'source': 's', 'target': 't', 'sites': ['example.com']}),
                             ('status', {'transfer_id': 'a' * 32})]:
            output, calls = self.invoke(True, 'cookie_mirror', {'action': action, **args}, raw)
            self.assertNotIn(secret, json.dumps(output))
            self.assertEqual(calls[0][0], 'browser.cookie_mirror')
        module = load('native_tools')
        error = RuntimeError(secret)
        error.code = 'cookie_mirror_denied'
        error.data = {'cookie': secret}
        profile = SimpleNamespace(authority=SimpleNamespace(consume=lambda *a, **k: SimpleNamespace(owner='o', tool_call_id='c')),
                                  call=lambda *a: (_ for _ in ()).throw(error))
        result = module.make_tool_handler('browser_shared_cookie_mirror', profile)({'action': 'list_sites', 'source': 's'})
        self.assertNotIn(secret, result)
        self.assertIn('cookie_mirror_denied', result)

    def test_upload_readback_exposes_names_but_not_local_paths(self):
        # 中文注释：只公开浏览器文件输入读回的文件名，不公开任务私有副本路径。
        projected = load('runtime')._project_tool_result('browser_shared_run', {'action': 'files.upload'},
            {'selectedCount': 1, 'selectedFiles': ['logo.png'], 'selectionState': 'applied',
             'localPath': '/private/task/secret/logo.png'})
        self.assertEqual(projected['selectedFiles'], ['logo.png'])
        self.assertNotIn('localPath', projected)

    def test_complex_ui_fields_reach_public_tool_without_sensitive_values(self):
        # 中文注释：合成扩展回执穿过公共工具投影，逐字段检查且拒绝输入值和额外属性。
        semantic = {'version': 2, 'snapshotId': 's', 'binding': {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'},
                    'items': [{'ref': 'r', 'role': 'button', 'name': '保存', 'inferred': True,
                               'value': CANARY, 'attributes': {'title': CANARY}}],
                    'coverage': {'unsupportedCanvas': 1, 'complete': True, 'pageError': CANARY}}
        result, _ = self.invoke(True, 'run', {'task_id': 't', 'tab_id': 1, 'action': 'semantic_snapshot'}, semantic)
        self.assertIs(result['items'][0]['inferred'], True)
        self.assertEqual(result['coverage']['unsupportedCanvas'], 1)
        self.assertNotIn(CANARY, json.dumps(result))
        for action in ('ref_click', 'ref_fill', 'ref_press', 'ref_set_checked', 'ref_select_option'):
            with self.subTest(action=action):
                projected = load('runtime')._project_tool_result('browser_shared_run', {'action': action},
                                                                {'relocated': True, 'value': CANARY})
                self.assertEqual(projected, {'relocated': True})

    # 中文注释：新字段通过公共投影，嵌套 value、属性及 AX 原始节点仍全部丢弃。
    def test_semantic_context_states_and_ax_coverage_survive_closed_projection(self):
        semantic = {'version': 2, 'snapshotId': 's', 'binding': {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'},
                    'items': [{'ref': 'r', 'role': 'button', 'name': '保存', 'nameSource': 'accessibility',
                               'expanded': False, 'selected': True, 'required': True, 'parentRef': 'row',
                               'context': [{'ref': 'row', 'role': 'row', 'name': '设备', 'index': 51, 'value': CANARY}],
                               'value': CANARY, 'axNodes': [CANARY]}],
                    'coverage': {'complete': False, 'axDiscoveryComplete': True, 'axEnriched': 1, 'axOmitted': 1},
                    'contentFilter': {'enabled': True, 'unreadFrames': 1}}
        result, _ = self.invoke(True, 'run', {'task_id': 't', 'tab_id': 1, 'action': 'semantic_snapshot'}, semantic)
        self.assertEqual(result['items'][0]['nameSource'], 'accessibility')
        self.assertFalse(result['items'][0]['expanded'])
        self.assertEqual(result['items'][0]['context'][0]['index'], 51)
        self.assertEqual(result['coverage']['axEnriched'], 1)
        self.assertEqual(result['contentFilter']['unreadFrames'], 1)
        self.assertNotIn(CANARY, json.dumps(result))

    def test_complex_ui_error_summaries_reach_public_tool(self):
        # 中文注释：模拟 daemon 异常，检查 Hermes JSON 只含固定码与脱敏摘要。
        module = load('native_tools')
        binding = {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'}
        cases = {
            'reference_target_missing': {'candidates': [{'role': 'button', 'name': '保存', 'value': CANARY}]},
            'reference_target_ambiguous': {'candidates': [{'role': 'button', 'name': '保存', 'value': CANARY}]},
            'target_occluded': {'obstruction': {'role': 'dialog', 'name': '遮挡层', 'value': CANARY,
                'closeButton': {'binding': binding, 'snapshotId': 's', 'ref': 'r', 'name': '关闭', 'value': CANARY}}},
            **{code: {} for code in ('target_disabled', 'target_hidden', 'target_zero_size',
                                    'target_out_of_viewport', 'closed_shadow_unavailable',
                                    'cross_origin_frame_unavailable')},
        }
        for code, detail in cases.items():
            with self.subTest(code=code):
                error = RuntimeError(CANARY)
                error.code = code
                error.data = {'outcomeUnknown': False, **detail, 'pageException': CANARY}
                profile = SimpleNamespace(authority=SimpleNamespace(
                    consume=lambda *a, **kw: SimpleNamespace(owner='tool:synthetic', tool_call_id='c')),
                    call=lambda *a, **kw: (_ for _ in ()).throw(error))
                result = json.loads(module.make_tool_handler('browser_shared_run', profile)(
                    {'task_id': 't', 'tab_id': 1, 'action': 'ref_click',
                     'binding': binding, 'snapshot_id': 's', 'ref': 'r'}, session_id='test'))
                self.assertEqual(result['code'], code)
                self.assertFalse(result['outcome_unknown'])
                self.assertNotIn(CANARY, json.dumps(result))
                if code.startswith('reference_'):
                    self.assertEqual(result['candidates'], [{'role': 'button', 'name': '保存'}])
                if code == 'target_occluded':
                    self.assertEqual(result['obstruction']['closeButton']['binding'], binding)

    def test_redirected_out_of_scope_reaches_shared_run(self):
        # 中文注释：new_tab/navigate 跨站跳转应保留固定码与来源，而不是改写成结果不确定。
        module = load('native_tools')
        for action in ('new_tab', 'navigate'):
            with self.subTest(action=action):
                error = RuntimeError(CANARY)
                error.code = 'redirected_out_of_scope'
                error.data = {'outcomeUnknown': False, 'finalOrigin': 'https://other.example', 'pageException': CANARY}
                profile = SimpleNamespace(authority=SimpleNamespace(
                    consume=lambda *a, **kw: SimpleNamespace(owner='tool:synthetic', tool_call_id='c')),
                    call=lambda *a, **kw: (_ for _ in ()).throw(error))
                args = {'task_id': 't', 'action': action, 'url': 'https://example.test/'}
                if action == 'navigate':
                    args['tab_id'] = 1
                result = json.loads(module.make_tool_handler('browser_shared_run', profile)(args, session_id='test'))
                self.assertEqual(result['bridgeCode'], 'redirected_out_of_scope')
                self.assertEqual(result['finalOrigin'], 'https://other.example')
                self.assertFalse(result['outcome_unknown'])
                self.assertNotIn(CANARY, json.dumps(result))

    def test_pre_dispatch_url_rejection_is_not_unknown(self):
        # 中文注释：导航前的网址校验拒绝未派发，不应标记为结果不确定；显式 unknown 仍保留。
        module = load('native_tools')
        for code in ('origin_denied', 'invalid_url'):
            for reported, expected in ((None, False), (True, True)):
                with self.subTest(code=code, reported=reported):
                    error = RuntimeError(CANARY)
                    error.code = code
                    error.data = {} if reported is None else {'outcomeUnknown': reported}
                    profile = SimpleNamespace(authority=SimpleNamespace(
                        consume=lambda *a, **kw: SimpleNamespace(owner='tool:synthetic', tool_call_id='c')),
                        call=lambda *a, **kw: (_ for _ in ()).throw(error))
                    result = json.loads(module.make_tool_handler('browser_shared_run', profile)(
                        {'task_id': 't', 'tab_id': 1, 'action': 'navigate', 'url': 'https://other.example/'}, session_id='test'))
                    self.assertIs(result['outcome_unknown'], expected)

    def test_content_shield_rejection_keeps_code_and_dispatch_fact(self):
        # 中文注释：保护拒绝是明确失败，不能丢失错误码或把未派发的原始截图误报成未知写入。
        module = load('native_tools')
        for code in ('content_shield_unsupported', 'content_shield_unavailable'):
            for unknown in (False, True):
                with self.subTest(code=code, unknown=unknown):
                    error = RuntimeError(CANARY)
                    error.code = code
                    error.data = {'outcomeUnknown': unknown, 'retryable': False}
                    profile = SimpleNamespace(authority=SimpleNamespace(
                        consume=lambda *a, **kw: SimpleNamespace(owner='tool:synthetic', tool_call_id='c')),
                        call=lambda *a, **kw: (_ for _ in ()).throw(error))
                    result = json.loads(module.make_tool_handler('browser_shared_run', profile)(
                        {'task_id': 't', 'tab_id': 1, 'action': 'cdp.send', 'method': 'Page.captureScreenshot'}, session_id='test'))
                    self.assertEqual(result['code'], code)
                    self.assertIs(result['outcome_unknown'], unknown)
                    self.assertNotIn(CANARY, json.dumps(result))

    def test_navigation_state_survives_public_tool_projection(self):
        # 中文注释：导航未就绪与离开授权范围必须保留，未声明的字段仍不能穿过公共工具边界。
        for action in ('navigate', 'new_tab'):
            with self.subTest(action=action):
                args = {'task_id': 't', 'action': action, 'url': 'https://example.test/'}
                if action == 'navigate':
                    args['tab_id'] = 1
                result, _ = self.invoke(True, 'run', args,
                    {'tabId': 1, 'url': 'https://example.test/', 'ready': False, 'debug': CANARY})
                # 中文注释：1.3.6 起 navigate 固定带精简摘要字段（未就绪时为 None）。
                self.assertEqual({k: v for k, v in result.items() if not (k == 'summary' and v is None)},
                                 {'tabId': 1, 'url': 'https://example.test/', 'ready': False})
        result, _ = self.invoke(True, 'run', {'task_id': 't', 'action': 'tabs'},
            [{'id': 1, 'outOfScope': True, 'debug': CANARY}])
        self.assertEqual(result, [{'id': 1, 'outOfScope': True}])

    def test_completed_click_keeps_navigation_metadata(self):
        # 中文注释：C 的点击回执不能被旧结果白名单丢弃，调用者需知道已跳出任务范围。
        for action, target in [('click', {'selector': '#leave'}), ('ref_click', {
                'binding': {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'},
                'snapshot_id': 's', 'ref': 'r'})]:
            with self.subTest(action=action):
                result, _ = self.invoke(True, 'run', {'task_id': 't', 'tab_id': 1,
                    'action': action, **target}, {'clicked': True, 'documentChanged': True,
                    'outOfScope': True, 'debug': CANARY})
                self.assertEqual(result, {'clicked': True, 'documentChanged': True, 'outOfScope': True})

    def test_content_filter_metadata_survives_closed_result_projection(self):
        # 中文注释：过滤标记必须传到 agent，同时仍然丢弃未声明的元数据字段。
        runtime = load('runtime')
        # 中文注释：站点禁止声明 true 与普通提示注入 false 都必须原样保留。
        for restricted in (True, False):
            for action in ('snapshot', 'semantic_snapshot', 'page.parse', 'screenshot', 'interaction.capture'):
                with self.subTest(action=action, restricted=restricted):
                    metadata = {'enabled': True, 'removedSegments': 2, 'siteAutomationRestricted': restricted}
                    result = runtime._project_tool_result('browser_shared_run', {'action': action}, {
                        'contentFilter': {**metadata, 'private': CANARY},
                    })
                    self.assertEqual(result['contentFilter'], metadata)
                    self.assertNotIn(CANARY, json.dumps(result))

    def invoke(self, shared, suffix, args, result):
        module = load('native_tools')
        calls = []
        def call(method, params):
            calls.append((method, params))
            if method == 'task.get' and suffix == 'run':
                return {'generation': 1}
            return result
        profile = SimpleNamespace(authority=SimpleNamespace(
            consume=lambda *a, **kw: SimpleNamespace(owner='tool:synthetic', tool_call_id='call-1')),
            call=call)
        tool = 'browser_shared_' + suffix
        output = json.loads(module.make_tool_handler(tool, profile)(args, session_id='test'))
        return output, calls

    def test_handler_result_envelopes_and_api_top_level_fields(self):
        for shared in (True,):
            with self.subTest(shared=shared):
                task, _ = self.invoke(shared, 'get', {'task_id': 't'},
                    {'id': 't', 'generation': 3, 'title': 'task', 'state': 'ready',
                     'debug': CANARY, 'owner': CANARY})
                self.assertEqual(task, {'id': 't', 'generation': 3, 'title': 'task', 'state': 'ready'})
                args = {'task_id': 't', 'action': 'snapshot'}
                if shared:
                    args['tab_id'] = 1
                snap, calls = self.invoke(shared, 'run', args,
                    {'text': 'business text', 'title': 'page', 'debug': CANARY,
                     'elements': [{'tag': 'BUTTON', 'text': 'buy', 'sensitive': False,
                                   'password': CANARY}]})
                self.assertNotIn(CANARY, json.dumps(snap))
                self.assertEqual(snap['text'], 'business text')
                self.assertEqual(snap['elements'][0]['text'], 'buy')
                self.assertEqual(sum(m.endswith('.run') for m, _ in calls), 1)
        result, _ = self.invoke(True, 'run', {'task_id': 't', 'action': 'api_request',
            'tab_id': 1, 'url': 'https://example.com/api', 'fields': ['rows', 'count']},
            {'status': 200, 'headers': {'Set-Cookie': CANARY}, 'debug': CANARY,
             'data': {'rows': [{'name': 'coffee', 'value': 4, 'key': 'sku',
                               'access_token': CANARY}], 'count': 1, 'extra': CANARY}})
        self.assertEqual(result, {'status': 200, 'data': {
            'rows': [{'name': 'coffee', 'value': 4, 'key': 'sku'}], 'count': 1}})

    def test_semantic_and_action_compatibility(self):
        semantic = {'version': 2, 'binding': {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'},
            'snapshotId': 's', 'kind': 'delta', 'mode': 'table', 'baselineId': 'old',
            'items': [{'ref': 'r', 'role': 'row', 'name': 'normal', 'cells': ['a', 'b'],
                       'disabled': False, 'checked': True, 'omittedCells': 0}],
            'removed': ['r0'], 'order': ['r'], 'nextCursor': 'c', 'resync': None,
            'coverage': {'scanned': 2, 'matched': 1, 'returned': 1, 'omitted': 0,
                         'complete': True, 'traversalComplete': True, 'scope': 'light-dom'},
            'budget': {'kind': 'estimated', 'method': 'chars/4', 'limit': 512}}
        for shared in (True,):
            args = {'task_id': 't', 'action': 'semantic_snapshot'}
            if shared:
                args['tab_id'] = 1
            output, _ = self.invoke(shared, 'run', args, {**semantic, 'debug': CANARY})
            self.assertEqual(output, semantic)
            for action, params, expected in [
                ('ref_click', {'binding': semantic['binding'],
                  ('snapshot_id' if shared else 'snapshotId'): 's', 'ref': 'r'},
                  {'clicked': True, 'kind': 'trusted-input', 'delivery': 'confirmed'}),
                ('ref_click', {'binding': semantic['binding'],
                  ('snapshot_id' if shared else 'snapshotId'): 's', 'ref': 'r'},
                  {'clicked': True, 'kind': 'dom-synthetic', 'delivery': 'confirmed',
                   'fallbackReason': 'background_tab_input_unreliable'}),
                # 中文注释：只公开最终选中的值、标签和索引，不泄露下拉框其他选项或调试字段。
                ('ref_select_option', {'binding': semantic['binding'],
                  ('snapshot_id' if shared else 'snapshotId'): 's', 'ref': 'r',
                  'by': 'label', 'values': ['甲']},
                  {'changed': True, 'verified': True, 'kind': 'native-select',
                   'selectedCount': 1, 'selectedOptions': [{'value': 'a', 'label': '甲', 'index': 0}]}),
            ]:
                call_args = {**args, 'action': action, **params}
                output, _ = self.invoke(shared, 'run', call_args, {**expected, 'debug': CANARY})
                self.assertEqual(output, expected)
        tabs, _ = self.invoke(True, 'run', {'task_id': 't', 'action': 'tabs'},
                              [{'id': 1, 'url': 'https://example.com', 'title': 'normal', 'debug': CANARY}])
        self.assertEqual(tabs, [{'id': 1, 'url': 'https://example.com', 'title': 'normal'}])

    def test_errors_are_fixed_and_unknown_is_never_retryable(self):
        for shared in (True,):
            module = load('native_tools')
            owner_error = module._runtime.OwnerLeaseError
            for error in (owner_error(CANARY), RuntimeError(CANARY)):
                profile = SimpleNamespace(authority=SimpleNamespace(
                    consume=lambda *a, **kw: SimpleNamespace(owner='tool:test', tool_call_id='c')))
                def call(*a, **kw):
                    raise error
                profile.call = call
                tool = 'browser_shared_list'
                out = json.loads(module.make_tool_handler(tool, profile)({}, session_id='test'))
                self.assertNotIn(CANARY, json.dumps(out))
                self.assertIs(out.get('retryable'), False)
            result, calls = self.invoke(shared, 'get', {'task_id': 't'},
                {'id': 't', 'state': 'needs_sync', 'lastError': CANARY})
            self.assertNotIn(CANARY, json.dumps(result))
            self.assertEqual(result['state'], 'needs_sync')
            self.assertEqual(len(calls), 1)
            result, _ = self.invoke(shared, 'run',
                {'task_id': 't', 'action': 'snapshot', **({'tab_id': 1} if shared else {})},
                {'error': {'message': CANARY}, 'code': CANARY, 'retryable': True})
            self.assertNotIn(CANARY, json.dumps(result))
            self.assertIn('error', result)
            self.assertIs(result.get('outcome_unknown'), True)
            self.assertIs(result.get('retryable'), False)

    def test_screenshot_artifact_and_tab_metadata_are_not_lost(self):
        runtime = load('runtime')
        tab = {'tabId': 'tab', 'url': 'https://example.com', 'title': 'page', 'selected': True}
        self.assertEqual(runtime._project_tool_result('browser_shared_run', {'action': 'tabs'},
                                                     [tab]), [tab])
        artifact = {'id': 'artifact', 'taskId': 't', 'mimeType': 'text/plain',
                    'size': 3, 'sha256': 'a' * 64}
        result, _ = self.invoke(True, 'run', {'task_id': 't', 'action': 'screenshot', 'tab_id': 1},
                                {'tabId': 'tab', 'data': 'AA==', 'artifact': artifact, 'debug': CANARY})
        self.assertEqual(result, {'tabId': 'tab', 'data': 'AA==', 'artifact': artifact})
        self.assertNotIn(CANARY, json.dumps(result))
        # 中文注释：遮罩摘要通过公共工具投影，但任意页面值仍被剔除。
        projected = runtime._project_tool_result('browser_shared_run', {'action': 'screenshot'},
            {'data': 'AA==', 'masked': [{'kind': 'sensitive_field', 'role': 'input', 'name': '敏感字段', 'value': CANARY}]})
        self.assertEqual(projected, {'data': 'AA==', 'masked': [{'kind': 'sensitive_field', 'role': 'input', 'name': '敏感字段'}]})

    def test_capture_errors_keep_specific_codes_without_page_text(self):
        # 中文注释：截图失败码跨到工具回执，错误原文和输入值不进入输出。
        module = load('native_tools')
        for code in ('capture_sensitive_blocked', 'capture_frame_uninspectable'):
            error = RuntimeError(CANARY)
            error.code, error.data = code, {'outcomeUnknown': False, 'fieldValue': CANARY}
            profile = SimpleNamespace(authority=SimpleNamespace(
                consume=lambda *a, **kw: SimpleNamespace(owner='tool:synthetic', tool_call_id='c')),
                call=lambda *a, **kw: (_ for _ in ()).throw(error))
            result = json.loads(module.make_tool_handler('browser_shared_run', profile)(
                {'task_id': 't', 'tab_id': 1, 'action': 'screenshot'}, session_id='test'))
            self.assertEqual(result['code'], code)
            self.assertNotIn(CANARY, json.dumps(result))

    def test_additional_credential_spellings_are_not_business_fields(self):
        keys = ['session_token', 'csrfToken', 'x-auth-token', 'client_secret', 'aws_secret_access_key',
                'accessKey', 'accessKeyId', 'secretAccessKey', 'Cookie', 'Set-Cookie', 'Authorization']
        for projector in (load('runtime')._strip_owner, load('native_tools')._public):
            result = projector({'rows': [{**dict.fromkeys(keys, CANARY),
                                'keyboard': 'normal', 'tokenCount': 3, 'secretary': 'normal'}]})
            self.assertNotIn(CANARY, json.dumps(result))
            self.assertEqual(result['rows'][0], {'keyboard': 'normal', 'tokenCount': 3, 'secretary': 'normal'})

    def test_api_business_state_is_not_a_task_and_schema_coverage_is_complete(self):
        tools, runtime = load('native_tools'), load('runtime')
        shared_actions = set(tools.TOOL_SCHEMAS['browser_shared_run']['parameters']['properties']['action']['enum'])
        # 中文注释：JS/CDP 经智能审批或全部访问后按既有体积限制返回，其余动作使用封闭投影。
        self.assertFalse(shared_actions - set(runtime._RESULT_ACTIONS) - {'api_request', 'js.evaluate', 'cdp.send', 'cdp.events'})
        rows = [{'name': 'business', 'state': 'pending_approval', 'value': 1}]
        output, _ = self.invoke(True, 'run', {'task_id': 't', 'action': 'api_request', 'tab_id': 1,
            'url': 'https://example.com/api', 'fields': ['rows']}, {'status': 200, 'data': {'rows': rows}})
        self.assertEqual(output, {'status': 200, 'data': {'rows': rows}})

    def test_approval_health_and_list_envelopes(self):
        output, _ = self.invoke(True, 'health', {}, {'ok': True, 'protocolVersion': 1, 'debug': CANARY})
        self.assertEqual(output, {'ok': True, 'protocolVersion': 1})
        output, _ = self.invoke(True, 'browsers', {}, [{'instanceId': 'i', 'browser': 'edge',
            'version': '1', 'connected': True, 'credentials': CANARY}])
        self.assertEqual(output, [{'instanceId': 'i', 'browser': 'edge', 'version': '1', 'connected': True}])
        output, calls = self.invoke(True, 'run', {'task_id': 't', 'action': 'click', 'tab_id': 1,
            'selector': '#buy', 'request_id': 'r'}, {'status': 'approval_required', 'requestId': 'r',
                'digest': 'd', 'expiresAt': 42, 'message': CANARY, 'nonce': CANARY})
        self.assertEqual(output['status'], 'approval_required')
        self.assertEqual(output['requestId'], 'r')
        self.assertNotIn(CANARY, json.dumps(output))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]['requestId'], 'r')
        for shared in (True,):
            output, _ = self.invoke(shared, 'list', {}, [{'id': 't', 'state': 'ready',
                    'title': {'debug': CANARY}, 'lastError': CANARY}])
            self.assertEqual(output[0]['id'], 't')
            self.assertNotIn(CANARY, json.dumps(output))

    def test_unknown_result_flags_cannot_be_dropped_or_made_retryable(self):
        for shared in (True,):
            result, calls = self.invoke(shared, 'run', {'task_id': 't', 'action': 'snapshot',
                **({'tab_id': 1} if shared else {})},
                {'status': 'outcome_unknown', 'retryable': True, 'message': CANARY})
            self.assertIs(result.get('outcome_unknown'), True)
            self.assertIs(result.get('retryable'), False)
            self.assertNotIn(CANARY, json.dumps(result))
            self.assertEqual(sum(m.endswith('.run') for m, _ in calls), 1)
            result, _ = self.invoke(shared, 'get', {'task_id': 't'}, {'id': 't', 'state': 'needs_sync'})
            self.assertEqual(result['id'], 't')
            self.assertIs(result.get('outcome_unknown'), True)
            self.assertIs(result.get('retryable'), False)

    def test_both_audit_projectors_block_recursive_credentials(self):
        payload = {'owner': CANARY, 'cookies': [{'value': CANARY}],
                   'headers': {'Authorization': 'Bearer ' + CANARY},
                   'items': [{'business': {'SeT-CoOkIe': CANARY, 'accessToken': CANARY,
                              'refresh_token': CANARY, 'api-key': CANARY,
                              'clientSecret': CANARY, 'password': CANARY,
                              'storageState': CANARY, 'private_key': CANARY},
                              'name': 'ordinary', 'tokenCount': 17, 'key': 'Enter',
                              'leaseId': 'semantic-binding'}]}
        for projector in (load('runtime')._strip_owner, load('native_tools')._public):
            with self.subTest(projector=projector.__name__):
                result = projector(payload)
                self.assertNotIn(CANARY, json.dumps(result))
                self.assertEqual(result['items'][0]['name'], 'ordinary')
                self.assertEqual(result['items'][0]['tokenCount'], 17)
                self.assertEqual(result['items'][0]['key'], 'Enter')
                self.assertEqual(result['items'][0]['leaseId'], 'semantic-binding')
        self.assertEqual(payload['owner'], CANARY)  # Never mutate backend/cache.


if __name__ == '__main__':
    unittest.main()
