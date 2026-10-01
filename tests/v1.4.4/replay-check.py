"""中文注释：检查合成动作/错误码契约，不读取数据库、页面、历史脚本或原始参数。"""
import importlib.util
import json
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run():
    tools = load('replay_tools', 'executor-plugin/native_tools.py')
    child = load('replay_child', 'executor-plugin/script_lane/child.py')
    runtime = types.SimpleNamespace(authority=types.SimpleNamespace(consume=lambda *a, **k: types.SimpleNamespace(owner='synthetic')))
    result = json.loads(tools.make_tool_handler('browser_shared_run', runtime)({'task_id':'synthetic', 'action':'semantic_snapshot'}))
    assert (result['code'], result['fields']) == ('missing_fields', ['tab_id'])
    rows = [{'action': 'semantic_snapshot', 'old_code':'invalid_arguments', 'new_return':result, 'validation':'executed_synthetic_contract'}]
    # 中文注释：仅使用合成的 61 秒参数核对上限，不使用真实任务参数。
    for timeout in [61]:
        try:
            child.wait_for('#synthetic', timeout=timeout)
            raise AssertionError('必须拒绝超限等待')
        except child.BrowserError as exc:
            assert exc.code == 'invalid_fields' and '0_60' in str(exc)
            rows.append({'action':'wait_for', 'old_code':'invalid_params', 'new_return': {'code':exc.code, 'fields':['timeout'], 'reason':'timeout_must_be_in_0_60_seconds'}, 'validation':'executed_synthetic_contract'})
    # 中文注释：说明改动不会自动修复旧脚本；保持同码的案例明确列出，不能伪称失败已消除。
    guidance = {
        'KeyError':'仍为 KeyError；page_text 读 elements、read_page 读 items 后才避免 dict 切片误用；业务缺字段未修复',
        'js_syntax_error':'仍为 js_syntax_error；用 evaluate(function, arguments) 传值后再核实源码',
        'js_exception':'仍为 js_exception；核实 selector 和 isolated/main，不自动切世界',
        'element_timeout':'仍为 element_timeout；改 role/root/name 或停止，不重复等待',
        'ambiguous_target':'仍拒绝；按 role/root 缩小，不取第一个',
        'origin_denied':'仍拒绝；可核实时附 currentOrigin（仅来源）及 goto_url/open 提示',
        'tab_out_of_scope':'仍拒绝；附已核实 currentOrigin（仅来源）及 goto_url/open 提示',
        'overlay_injection_failed':'仍拒绝；附 stage=overlay、reasonCode=initialization_exception 或 return_type_invalid',
        'execution_denied':'未分类错误仍保持 execution_denied；不猜底层原因',
        'target_unavailable':'仍拒绝；明确文档切换时保留 document_changed；不猜网站原因',
        'invalid_params':'字段校验使用 invalid_fields；不重放错误参数',
    }
    codes = ['js_syntax_error','KeyError','element_timeout','js_exception','origin_denied','invalid_params',
             'SyntaxError','ambiguous_target','target_occluded','NameError','execution_denied','target_zero_size',
             'TypeError','js_timeout','capture_sensitive_blocked','invalid_state','permission_denied',
             'script_timeout','AttributeError','ModuleNotFoundError','task_closed','tab_out_of_scope','target_unavailable',
             'unclassified_script_failure','overlay_injection_failed','unknown','extension_timeout']
    for code in codes:
        rows.append({'action': 'resume' if code=='invalid_state' else 'screenshot' if code=='capture_sensitive_blocked' else 'semantic_snapshot' if code=='overlay_injection_failed' else 'script',
                     'old_code':code,'new_return':guidance.get(code,'保留原拒绝/异常/未知结果；不自动重试、不扩大授权'), 'validation':'reasoned_mapping_only'})
    return {'source':'Synthetic action/error contract examples', 'records':rows,
            'limits':'这不是原会话或页面回放；只实际执行缺 tab_id 和超限等待的合成参数，其余为保留行为映射。'}


if __name__ == '__main__':
    print(json.dumps(run(), ensure_ascii=False, indent=2))
