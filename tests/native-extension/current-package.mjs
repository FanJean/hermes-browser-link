import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const exec=promisify(execFile);

export async function buildCurrentPackageArchive(repo,work,python){
 const output=path.join(work,'built-package');
 const archive=path.join(work,'current-package.zip');
 // 中文注释：测试需要 ZIP 时从当前源码构建，避免依赖旧发布候选包。
 await exec(process.execPath,[path.join(repo,'scripts/package-executor.mjs'),'--output',output],{cwd:repo,timeout:120000});
 const zipCode=`from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
import sys
root=Path(sys.argv[1]);archive=Path(sys.argv[2])
with ZipFile(archive,'w',compression=ZIP_DEFLATED) as bundle:
    for file in sorted(root.rglob('*')):
        if file.is_file():bundle.write(file,file.relative_to(root).as_posix())`;
 await exec(python,['-c',zipCode,output,archive],{cwd:repo,timeout:120000});
 return archive;
}
