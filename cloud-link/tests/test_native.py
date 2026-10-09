"""独立 Native host 的真实帧、授权入口和配对码检查。"""
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'cloud-link'))
from runtime.service import connection_code

class NativeCloudTests(unittest.TestCase):
    def test_paired_native_protocol_rejects_obsolete_full_access_toggle(self):
        spec=importlib.util.spec_from_file_location('cloud_native_test',ROOT/'cloud-link/native_host.py')
        assert spec is not None and spec.loader is not None
        native_host=importlib.util.module_from_spec(spec);spec.loader.exec_module(native_host)
        origin='chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'
        service=Mock();service.view.return_value={'state':'active','paired':True,'fullAccess':True}
        service.set_full_access.return_value={'state':'active','paired':True,'fullAccess':False}
        messages=[{'id':'hello','method':'hello','params':{'instance_id':'11111111-1111-4111-8111-111111111111','browser':'Chrome'}},
                  {'id':'full','method':'full_access','params':{'enabled':False}},EOFError()]
        replies=[]
        def thread(*,target,args,**kwargs):
            return Mock(start=lambda:target(*args))
        with patch.object(native_host.sys,'argv',['native_host.py',origin]), \
             patch.object(native_host.framing,'_load_allowed_origins',return_value=[origin]), \
             patch.object(native_host.framing,'read_native_message',side_effect=messages), \
             patch.object(native_host.framing,'write_native_message',side_effect=lambda _out,value,_lock:replies.append(value)), \
             patch.object(native_host,'CloudService',return_value=service), \
             patch.object(native_host.threading,'Thread',side_effect=thread), \
             patch.object(native_host.signal,'signal'):
            self.assertEqual(native_host.main(),0)
        self.assertIn('error',replies[1]);service.set_full_access.assert_not_called()
        service.close.assert_called_once()

    def test_native_channel_does_not_start_local_daemon_or_accept_unpaired_full_access(self):
        with tempfile.TemporaryDirectory(prefix='hcn-') as scratch:
            home=Path(scratch).resolve();native=home/'plugin-data/browser-link-native';native.mkdir(parents=True)
            origin='chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/'
            config=native/'host-config.json';config.write_text(json.dumps({'allowedOrigins':[origin]}));before=config.read_bytes()
            messages=[{'id':'hello','method':'hello','params':{'instance_id':'11111111-1111-4111-8111-111111111111','browser':'Chrome'}},
                      {'id':'full','method':'full_access','params':{'enabled':True}}]
            wire=b''.join(struct.pack('<I',len(payload))+payload for payload in [json.dumps(m).encode() for m in messages])
            result=subprocess.run([sys.executable,str(ROOT/'cloud-link/native_host.py'),origin],input=wire,capture_output=True,env={**os.environ,'HERMES_HOME':str(home)},timeout=10)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            stream=result.stdout; replies={}
            while stream:
                size=struct.unpack('<I',stream[:4])[0];reply=json.loads(stream[4:4+size]);replies[reply.get('id')]=reply;stream=stream[4+size:]
            self.assertFalse(replies['hello']['result']['fullAccess'])
            self.assertIn('error',replies['full'])
            self.assertFalse((native/'bridge.sock').exists());self.assertEqual(before,config.read_bytes())
    def test_invalid_native_origin_is_rejected_before_creating_cloud_state(self):
        with tempfile.TemporaryDirectory(prefix='hcn-') as scratch:
            result=subprocess.run([sys.executable,str(ROOT/'cloud-link/native_host.py'),'chrome-extension://wrong/'],capture_output=True,env={**os.environ,'HERMES_HOME':scratch},timeout=5)
            self.assertEqual(result.returncode,3);self.assertEqual(result.stdout,b'')
            self.assertFalse((Path(scratch)/'plugin-data/browser-link-cloud').exists())
    def test_connection_code_is_readable_and_unique(self):
        codes={connection_code() for _ in range(100)};self.assertEqual(len(codes),100)
        for code in codes:self.assertRegex(code,r'^[2-9A-HJ-NP-Z]{6}-[2-9A-HJ-NP-Z]{6}$')

if __name__=='__main__': unittest.main()
