import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native-bridge'))
from daemon import BridgeDaemon, ProtocolError

class Integration(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
  self.d=BridgeDaemon(Path(self.tmp.name));self.d._prepare_data_dir()
  self.d.extensions['instance']={'browser':'chrome'}
  self.d._notify_tasks_changed=lambda *_:None
  self.task=self.d._create_task({'owner':'SECRET_OWNER','title':'SECRET_TITLE','instanceId':'instance','allowedOrigins':['https://example.test']})
  self.d._dispatch_extension('instance','extension.approve',{'taskId':self.task['id'],'tabIds':[1],'allowedOrigins':['https://example.test']})
  self.d._dispatch_extension('instance','extension.mode',{'taskId':self.task['id'],'mode':'full','generation':1,'modeGeneration':1})
  self.calls=[]
  def call(*a,**kw):
   self.calls.append(a);return {'tabId':10,'windowId':7,'groupId':20,'url':'https://example.test/?SECRET_BODY'}
  self.d._extension_call=call
  self.p={'owner':'SECRET_OWNER','taskId':self.task['id'],'action':'new_tab','requestId':'SECRET_REQUEST','url':'https://example.test/?SECRET_COOKIE'}
 def tearDown(self):self.tmp.cleanup()
 def test_lifecycle_and_metadata(self):
  result=self.d._dispatch_client('shared.run',self.p)
  public=self.d._dispatch_client('shared.get',{'owner':'SECRET_OWNER','taskId':self.task['id']})
  self.assertEqual(public['workTabs'],[{'tabId':10,'windowId':7,'groupId':20}])
  events=self.d.diagnostics.read_validated_events()
  self.assertEqual([e['status'] for e in events if e['event_type']=='request_state'],['running','succeeded'])
  self.assertNotIn('SECRET',json.dumps(events))
  self.assertEqual(self.d._dispatch_client('shared.run',self.p),result)
  self.assertEqual(len(self.calls),1)
 def test_workspace_uncertainty_revokes_task_without_replay(self):
  def lost(*a,**kw):raise ProtocolError('workspace_unknown','workspace outcome unknown')
  self.d._extension_call=lost
  with self.assertRaises(ProtocolError):self.d._run_task(self.p)
  self.assertEqual(self.d.tasks[self.task['id']]['state'],'needs_sync')
  with self.assertRaises(ProtocolError) as error:self.d._run_task(self.p)
  self.assertEqual(error.exception.code,'request_outcome_unavailable')
 def test_full_mode_unexpected_exception_is_unknown_and_cannot_replay(self):
  def lost(*a,**kw):raise RuntimeError('SECRET_EXCEPTION')
  self.d._extension_call=lost
  with self.assertRaises(RuntimeError):self.d._run_task(self.p)
  self.assertEqual(self.d.tasks[self.task['id']]['state'],'needs_sync')
  with self.assertRaises(ProtocolError) as error:self.d._run_task(self.p)
  self.assertEqual(error.exception.code,'request_outcome_unavailable')
  events=self.d.diagnostics.read_validated_events()
  self.assertNotIn('SECRET',json.dumps(events));self.assertEqual(events[-1]['status'],'unknown')
 def test_sink_failure_and_unknown_no_replay(self):
  class Broken:
   def write(self,event):raise OSError('SECRET_COOKIE')
  self.d.diagnostics=Broken()
  def lost(*a,**kw):raise ProtocolError('extension_timeout','SECRET_BODY')
  self.d._extension_call=lost
  with self.assertRaises(ProtocolError) as error:self.d._run_task(self.p)
  self.assertEqual(error.exception.code,'extension_timeout')
  with self.assertRaises(ProtocolError) as error:self.d._run_task(self.p)
  self.assertEqual(error.exception.code,'request_outcome_unavailable')
  self.assertEqual(self.d.tasks[self.task['id']]['workspaceState'],'unknown')

class PackageImports(unittest.TestCase):
 def test_adjacent_host_bin_dependency_is_self_contained(self):
  import shutil, subprocess
  with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as root:
   host=Path(root)/'host-bin';host.mkdir()
   for name in ('daemon.py','api_client.py'):
    shutil.copy2(ROOT/'native-bridge'/name,host/name)
   shutil.copytree(ROOT/'browser-diagnostics/python/browser_diagnostics',host/'browser_diagnostics',ignore=shutil.ignore_patterns('__pycache__'))
   code="import sys,pathlib;sys.path.insert(0,sys.argv[1]);from daemon import BridgeDaemon,JsonlDiagnosticSink;assert JsonlDiagnosticSink is not None;d=BridgeDaemon(pathlib.Path(sys.argv[2]));d._prepare_data_dir();d._diagnostic('request_state','running');assert d.diagnostics.read_validated_events()[0]['status']=='running';assert pathlib.Path(sys.modules['browser_diagnostics'].__file__).is_relative_to(pathlib.Path(sys.argv[1]));print('adjacent host-bin validated')"
   result=subprocess.run([sys.executable,'-I','-c',code,str(host),str(Path(root)/'home')],cwd=root,env={k:v for k,v in os.environ.items() if k!='PYTHONPATH'},capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr);self.assertIn('validated',result.stdout)

if __name__=='__main__':unittest.main()
