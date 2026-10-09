import {spawnSync} from 'node:child_process';

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
    cli.assert_tasks_idle(home)
    cli.assert_daemon_stopped(home, os.environ)
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
