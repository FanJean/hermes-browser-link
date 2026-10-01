#!/usr/bin/env python3
"""TEST ONLY native framing peer; NOT real daemon/owner authentication."""
import json, os, struct, sys, threading, time
from pathlib import Path
root = Path(os.environ['HERMES_NATIVE_FIXTURE'])
config = json.loads((root/'config.json').read_text())
tasks = [{'id':x,'title':'测试任务 '+x,'state':'pending_approval','generation':1,'allowedOrigins':[config['origin']],'tabIds':[],'isolation':'shared-profile'} for x in ['a','b']]
lock=threading.Lock()
def send(m):
    raw=json.dumps(m).encode()
    with lock:
        sys.stdout.buffer.write(struct.pack('<I',len(raw))+raw);sys.stdout.buffer.flush()
def pump():
    with (root/'commands.jsonl').open() as f:
        f.seek(0, 2)
        while True:
            line=f.readline()
            if line:
                m=json.loads(line)
                if m.get('method')=='fixture.disconnect': os._exit(0)
                send(m)
            else: time.sleep(.03)
threading.Thread(target=pump,daemon=True).start()
while True:
    header=sys.stdin.buffer.read(4)
    if not header: break
    if len(header)!=4: raise RuntimeError('truncated frame')
    n=struct.unpack('<I',header)[0]
    if n>1024*1024: raise RuntimeError('oversize')
    m=json.loads(sys.stdin.buffer.read(n))
    with (root/'responses.jsonl').open('a') as f: f.write(json.dumps(m)+'\n')
    if 'method' not in m: continue
    method=m['method'];p=m.get('params',{});result={}
    if method=='extension.hello':
        for t in tasks:t.update(instanceId=p['instanceId'],browser=p['browser'])
        result={'connected':True}
    elif method=='extension.tasks':result=tasks
    elif method in ['extension.approve','extension.reject','extension.stop']:
        t=next(t for t in tasks if t['id']==p['taskId'])
        if method=='extension.approve':t.update(state='ready',tabIds=p['tabIds'])
        else:t['state']='cancelled'
        result=t
    send({'id':m['id'],'result':result})
