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

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'cloud-link'))
from runtime.service import connection_code

class NativeCloudTests(unittest.TestCase):
    def test_native_channel_does_not_start_local_daemon_or_accept_unpaired_full_access(self):
        with tempfile.TemporaryDirectory(prefix='hcn-',dir='/tmp') as scratch:
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
        with tempfile.TemporaryDirectory(prefix='hcn-',dir='/tmp') as scratch:
            result=subprocess.run([sys.executable,str(ROOT/'cloud-link/native_host.py'),'chrome-extension://wrong/'],capture_output=True,env={**os.environ,'HERMES_HOME':scratch},timeout=5)
            self.assertEqual(result.returncode,3);self.assertEqual(result.stdout,b'')
            self.assertFalse((Path(scratch)/'plugin-data/browser-link-cloud').exists())
    def test_connection_code_is_readable_and_unique(self):
        codes={connection_code() for _ in range(100)};self.assertEqual(len(codes),100)
        for code in codes:self.assertRegex(code,r'^[2-9A-HJ-NP-Z]{6}-[2-9A-HJ-NP-Z]{6}$')

if __name__=='__main__': unittest.main()
