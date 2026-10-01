"""Deterministically schedule FD reuse at the atomic-writer ownership boundary."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import daemon


class AtomicWriterLifecycleTests(unittest.TestCase):
    def test_atomic_write_does_not_close_reused_connection_fd(self):
        scratch = Path(tempfile.gettempdir())
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='fd-reg-', dir=scratch) as work:
            target = Path(work) / 'tasks.json'
            original_mkstemp = tempfile.mkstemp
            original_replace = os.replace
            allocated = []
            sockets = []

            def allocate(*args, **kwargs):
                fd, name = original_mkstemp(*args, **kwargs)
                allocated.append(fd)
                return fd, name

            def replace_and_accept(source, destination):
                # fdopen's context has closed the temporary file. Model a concurrent
                # accept() reusing its number before writer cleanup runs.
                result = original_replace(source, destination)
                left, right = socket.socketpair()
                sockets.extend([left, right])
                self.assertEqual(left.fileno(), allocated[0], 'schedule must reuse the released FD')
                return result

            try:
                with patch.object(daemon.tempfile, 'mkstemp', allocate), patch.object(daemon.os, 'replace', replace_and_accept):
                    daemon._atomic_write_private(target, b'{}')
                sockets[1].sendall(b'health\n')
                self.assertEqual(sockets[0].recv(7), b'health\n')
                self.assertEqual(target.read_bytes(), b'{}')
            finally:
                for sock in sockets:
                    try:
                        sock.close()
                    except OSError:
                        pass


# 中文注释：目标目录或文件创建失败时，源文件句柄仍必须关闭，已有文件不能被清理掉。
class DownloadDescriptorTests(unittest.TestCase):
    def test_claim_destination_failure_closes_source(self):
        import downloads
        with tempfile.TemporaryDirectory(prefix="download-fd-", dir="/tmp") as work:
            root = Path(work).resolve()
            source = root / "hermes-tasks" / "0123456789abcdef" / "sample.txt"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"sample")
            registry = downloads.DownloadRegistry(root / "home")
            row = {"id": "01234567-89ab-cdef-0123-456789abcdef", "key": "0123456789abcdef", "filename": "sample.txt",
                   "state": "complete", "path": str(source), "bytesReceived": 6}
            task = {"id": "t", "generation": 1, "downloads": [row]}
            original = downloads._open_staged
            for mode in ("directory", "file"):
                with self.subTest(mode=mode):
                    opened = []
                    def record(path):
                        fd = original(path)
                        opened.append(fd)
                        return fd
                    destination = root / "claimed"
                    destination.mkdir(exist_ok=True)
                    existing = destination / "sample.txt"
                    existing.write_bytes(b"keep")
                    try:
                        with patch.object(downloads, "_open_staged", record), patch.object(
                                registry, "_claim_dir", side_effect=PermissionError("拒绝创建目录") if mode == "directory" else None,
                                return_value=destination):
                            with self.assertRaises(OSError):
                                registry.claim(task, row["id"])
                        self.assertEqual(existing.read_bytes(), b"keep")
                        self.assertEqual(len(opened), 1)
                        with self.assertRaises(OSError):
                            os.fstat(opened[0])
                    finally:
                        for fd in opened:
                            try:
                                os.close(fd)
                            except OSError:
                                pass


class NonRegularFileTests(unittest.TestCase):
    def test_fifo_is_rejected_without_waiting_for_a_writer(self):
        # 中文注释：隔离子进程保证回归即使阻塞也能被终止，不污染并行审计的 daemon 或测试线程。
        script = '''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from artifacts import ArtifactStore, ArtifactError, _open_regular
from downloads import DownloadRegistry, DownloadError
root, operation = Path(sys.argv[2]), sys.argv[3]
path = root / 'hermes-tasks' / '0123456789abcdef' / 'sample.txt'
path.parent.mkdir(parents=True)
os.mkfifo(path)
task = {'id': 'task', 'generation': 1, 'state': 'ready'}
try:
    if operation == 'upload':
        ArtifactStore(root).register_path(task=task, owner='owner', path=str(path))
    elif operation == 'manifest':
        _open_regular(path)
    else:
        row = {'id': '01234567-89ab-cdef-0123-456789abcdef', 'key': path.parent.name,
               'generation': 1, 'filename': path.name, 'state': 'complete', 'path': str(path), 'bytesReceived': 0}
        task['downloads'] = [row]
        DownloadRegistry(root).claim(task, row['id'])
except (ArtifactError, DownloadError) as error:
    assert str(error) in {'PATH_DENIED', 'ARTIFACT_CHANGED', 'DOWNLOAD_CHANGED'}
else:
    raise AssertionError('FIFO accepted as a regular file')
'''
        bridge = str(Path(__file__).resolve().parents[1])
        for operation in ('upload', 'manifest', 'download'):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory(dir='/tmp') as work:
                result = subprocess.run([sys.executable, '-c', script, bridge, str(Path(work).resolve()), operation],
                                        capture_output=True, text=True, timeout=2)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
