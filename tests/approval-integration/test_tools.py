import importlib.util, json, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('approval_native_tools',ROOT/'executor-plugin/native_tools.py')
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
class FakeError(Exception): code='approval_denied'
class Client:
    def call(self, method, params): raise FakeError('do not expose private input')
class CompatibilityTests(unittest.TestCase):
    def test_public_errors_keep_old_code_with_safe_additive_bridge_code(self):
        with tempfile.TemporaryDirectory() as home:
            runtime=tools._runtime.NativeProfileRuntime(Path(home),ROOT/'executor-plugin',bridge_client=Client())
            args={'task_id':'a','action':'click','tab_id':1,'selector':'#send'}
            modified=runtime.authority.pre_tool_call('browser_shared_run',args,session_id='s',tool_call_id='c')
            args.update(modified['args'])
            result=json.loads(tools.make_tool_handler('browser_shared_run',runtime)(args,session_id='s'))
            self.assertEqual(result['code'],'bridge_error')
            self.assertEqual(result.get('bridgeCode'),'approval_denied')
            self.assertNotIn('private input',result['error'])
    def test_model_cannot_supply_approval_mode_nonce_or_owner(self):
        for key in ['activeMode','approval','nonce','owner','modeGeneration','capabilities']:
            with self.assertRaises(ValueError):
                tools._validate('browser_shared_run',{'task_id':'a','action':'click','tab_id':1,'selector':'#x',key:'full'})
if __name__=='__main__': unittest.main()
