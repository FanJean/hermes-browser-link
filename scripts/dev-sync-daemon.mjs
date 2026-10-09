import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {lstat,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

// 中文注释：正式 Python 门禁是唯一任务解析器；受控子进程持锁直到 Node 事务结束。
export function runDevelopmentGuard(home,repo,args=[],env=process.env){
 const code=`
import os, sys
from pathlib import Path
import importlib.util
import subprocess
repo, home = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('development_installer', repo / 'scripts/install-cli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
cli.EXECUTOR = cli.load_module('development_executor', repo / 'scripts/install-executor.py')
try:
    cli.assert_daemon_stopped(home, os.environ)
    cli.assert_tasks_idle(home, daemon_stopped=True)
    if len(sys.argv) > 3:
        with cli.development_sync_guard(home, os.environ) as locks:
            # 中文注释：Node 继承锁描述符；保护进程意外退出也不能提前解除事务保护。
            result = subprocess.run(sys.argv[3:], pass_fds=locks,
                                    env={**os.environ, 'BROWSER_LINK_DEV_GUARDED': '1'})
        sys.exit(result.returncode)
except (cli.InstallError, OSError, ValueError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;
 return spawnSync(env.BROWSER_LINK_TEST_PYTHON||'python3',['-c',code,repo,home,...args],
  {encoding:'utf8',...(args.length?{}:{timeout:30000}),env:{...env,PYTHONDONTWRITEBYTECODE:'1'}});
}

export function assertDevelopmentIdle(home,repo){
 const result=runDevelopmentGuard(home,repo);
 if(result.status!==0)throw Error(result.stderr||'无法核实同步空闲状态');
}

// 中文注释：维护步骤全部交给正式 Python 安装器执行，锁、权限和进程身份核对只有一份实现。
export function runMaintenanceStep(home,repo,step,args=[],env=process.env){
 const code=`
import json, os, sys
from pathlib import Path
import importlib.util
repo, home, step = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
spec = importlib.util.spec_from_file_location('development_installer', repo / 'scripts/install-cli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
cli.EXECUTOR = cli.load_module('development_executor', repo / 'scripts/install-executor.py')
try:
    if step == 'enter':
        result = cli.enter_maintenance(home, sys.argv[4], int(sys.argv[5]))
    elif step == 'leave':
        result = cli.leave_maintenance(home, sys.argv[4])
    elif step == 'stop':
        result = cli.stop_daemon(home, os.environ, float(sys.argv[4]))
    elif step == 'cloud':
        cli.wait_cloud_released(home, float(sys.argv[4]))
        result = True
    else:
        raise ValueError('unknown maintenance step')
    print(json.dumps(result))
except (cli.InstallError, OSError, ValueError) as error:
    fix = getattr(error, 'fix', '')
    print(str(error) + ('\\n处理：' + fix if fix else ''), file=sys.stderr)
    sys.exit(1)
`;
 const result=spawnSync(env.BROWSER_LINK_TEST_PYTHON||'python3',['-c',code,repo,home,step,...args.map(String)],
  {encoding:'utf8',timeout:120000,env:{...env,PYTHONDONTWRITEBYTECODE:'1'}});
 if(result.status!==0)throw Error(result.stderr.trim()||`维护步骤 ${step} 未完成`);
 return JSON.parse(result.stdout);
}

const TERMINAL=new Set(['closed','cancelled','failed']);
// 中文注释：只读解析任务记录，判断哪些任务还需要等待；正式放行仍由 Python 守卫在锁内决定。
export async function pendingTasks(tasksFile){
 let info;
 try{info=await lstat(tasksFile);}catch(error){if(error.code==='ENOENT')return {waiting:[],stale:[]};throw error;}
 if(!info.isFile())throw Error(`任务记录不是普通文件：${tasksFile}`);
 const value=JSON.parse(await readFile(tasksFile,'utf8'));
 if(!value||typeof value!=='object'||value.version!==1||!Array.isArray(value.tasks))throw Error('活动任务或状态无法核实：任务记录格式无法识别，拒绝同步');
 const waiting=[],stale=[];
 for(const task of value.tasks){
  if(!task||typeof task!=='object'||typeof task.id!=='string')throw Error('活动任务或状态无法核实：任务记录格式无法识别，拒绝同步');
  const row={id:task.id,title:typeof task.title==='string'?task.title.slice(0,80):'',state:String(task.state),cleanupState:String(task.cleanupState)};
  if(!TERMINAL.has(task.state)||task.cleanupState==='pending')waiting.push(row);
  // 中文注释：已结束但清理未知或失败的任务等待不会变化，需要用户核实后 tasks:ack。
  else if(task.cleanupState!=='succeeded')stale.push(row);
 }
 return {waiting,stale};
}

function describe(rows){return rows.map(row=>`  - ${row.id}  ${row.title||'(无标题)'}  [${row.state}/${row.cleanupState}]`).join('\n');}

export async function waitForTasks(tasksFile,{timeoutMs,intervalMs=1000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const deadline=Date.now()+timeoutMs;
 for(;;){
  const {waiting,stale}=await pendingTasks(tasksFile);
  if(stale.length)throw Error(`以下任务已结束但清理状态未确认，等待不会改变：\n${describe(stale)}\n核实浏览器里没有残留后运行 npm run tasks:ack -- <taskId> --stop-daemon，再重新同步。`);
  if(!waiting.length)return;
  if(Date.now()>=deadline)throw Error(`等待任务结束超时（${Math.round(timeoutMs/1000)} 秒），未停止任何进程。未结束的任务：\n${describe(waiting)}`);
  await sleep(Math.min(intervalMs,Math.max(0,deadline-Date.now())));
 }
}

// 中文注释：Hermes 的 ESTOP 只阻止新工作；开始前已暂停则同步后保持暂停，否则无论成败都恢复。
export function hermesControl(env=process.env){
 const hermes=env.BROWSER_LINK_HERMES||'hermes';
 const hermesHome=env.HERMES_HOME||path.join(homedir(),'.hermes');
 const run=args=>{
  const result=spawnSync(hermes,args,{encoding:'utf8',env,stdio:['ignore','pipe','pipe'],timeout:120000});
  if(result.error||result.status!==0)throw Error(`hermes ${args[0]} 未完成：${(result.stderr||result.error?.message||'').trim().slice(0,300)}`);
 };
 const wasPaused=existsSync(path.join(hermesHome,'ESTOP'));
 return {
  wasPaused,
  pause(reason){if(!wasPaused)run(['pause','--reason',reason]);},
  resume(){if(!wasPaused)run(['resume']);},
 };
}
