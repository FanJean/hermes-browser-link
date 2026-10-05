"""通信线程必须在任务等待期间保持在线，关闭后释放自己的线程与锁。"""
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from runtime.client import private_directory,save_config
from runtime.service import CloudService


class ServiceTests(unittest.TestCase):
    def test_waiting_task_does_not_block_exchange_or_native_shutdown(self):
        started=threading.Event(); release=threading.Event(); exchanges=[]
        class Executor:
            def __init__(self,*args,**kwargs):pass
            def execute(self,cmd):
                started.set();release.wait(5);return {'id':'task','state':'ready'}
            def close(self, *, sessions=()):release.set();return list(sessions)
            def handoff_session(self,session):raise AssertionError('活动任务不能被回收')
        class Relay:
            def __init__(self,config):pass
            def call(self,path,body):
                self_outer.assertEqual(path,'/device/exchange');exchanges.append(body)
                commands=[]
                if len(exchanges)==1:
                    commands=[{'id':'cmd','session_id':'session','device_id':'device','tool':'create',
                               'args':{'title':'test','allowed_origins':['https://example.com']},'expires_at':time.time()+30}]
                return {'device_id':'device','commands':commands,'receipts':[], 'closed_sessions':[]}
        self_outer=self
        with tempfile.TemporaryDirectory() as tmp:
            instance='11111111-1111-4111-8111-111111111111';home=Path(tmp)
            folder=home/'plugin-data/browser-link-cloud/instances'/instance;private_directory(folder)
            save_config(folder/'pairing.json',{'paired':True,'device_id':'device','site':'https://relay.test',
                        'device_secret':'private','sites_access_token':'private','allowed_origins':[],'full_access':False})
            with patch('runtime.service.CloudExecutor',Executor),patch('runtime.service.Relay',Relay):
                service=CloudService(home,instance,'Chrome',lambda *a:{'connected':True,'instanceId':instance})
                try:
                    self.assertTrue(started.wait(2))
                    deadline=time.monotonic()+3
                    while len(exchanges)<3 and time.monotonic()<deadline:time.sleep(.01)
                    self.assertGreaterEqual(len(exchanges),3)
                    self.assertTrue(service.view()['online']);self.assertFalse(release.is_set())
                finally:service.close()
                self.assertFalse(service.worker.is_alive());self.assertFalse(service.scheduler)
                self.assertTrue(release.is_set())

if __name__=='__main__':unittest.main()
