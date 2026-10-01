"""旧连接已读入的消息也必须在派发时重新核实连接身份。"""
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import daemon as module


class ConnectionGenerationTests(unittest.TestCase):
    def test_overlapping_hello_cannot_send_an_old_reply_to_the_new_socket(self):
        # 中文注释：在登记旧连接后精确暂停，使新连接在旧 hello 回执前完成替换。
        with tempfile.TemporaryDirectory(prefix='hello-', dir='/private/tmp') as directory:
            daemon = module.BridgeDaemon(Path(directory))
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda _: None
            daemon._ungroup_terminal_tasks = lambda *_: None
            entered, resume = threading.Event(), threading.Event()
            old_client, old_server = socket.socketpair()
            new_client, new_server = socket.socketpair()
            old_client.settimeout(3)
            new_client.settimeout(3)
            sends, errors = [], []
            original_lock = daemon.state_lock
            class Gate:
                fired = False
                def __enter__(self):
                    original_lock.acquire()
                def __exit__(self, *_):
                    pause = threading.current_thread().name == 'old-hello' and not self.fired and daemon.extensions.get('browser', {}).get('socket') is old_server
                    if pause:
                        self.fired = True
                    original_lock.release()
                    if pause:
                        entered.set()
                        if not resume.wait(5):
                            errors.append('hello gate timed out')
            daemon.state_lock = Gate()
            original_send = daemon._send_extension
            def send(extension, message):
                sends.append((message.get('id'), extension['socket']))
                original_send(extension, message)
            daemon._send_extension = send
            def serve(server):
                try:
                    with server.makefile('rb') as reader:
                        daemon._serve_extension(server, reader, 'chrome-extension://test/')
                except (EOFError, OSError):
                    pass
                except Exception as error:
                    errors.append(error)
            threads = [threading.Thread(target=serve, args=(old_server,), name='old-hello', daemon=True),
                       threading.Thread(target=serve, args=(new_server,), name='new-hello', daemon=True)]
            def hello(client, name):
                client.sendall(module._encode_line({'id': name, 'method': 'extension.hello',
                    'params': {'instanceId': 'browser', 'browser': 'chrome', 'version': 'test'}}))
            try:
                threads[0].start()
                hello(old_client, 'old')
                self.assertTrue(entered.wait(3))
                threads[1].start()
                hello(new_client, 'new')
                with new_client.makefile('rb') as reader:
                    self.assertEqual(json.loads(reader.readline())['id'], 'new')
                resume.set()
                threads[0].join(3)
                self.assertIn(('old', old_server), sends)
                self.assertNotIn(('old', new_server), sends)
                self.assertEqual(errors, [])
            finally:
                resume.set()
                for conn in (old_client, old_server, new_client, new_server):
                    try:
                        conn.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                for thread in threads:
                    if thread.ident:
                        thread.join(3)
                for conn in (old_client, old_server, new_client, new_server):
                    conn.close()

    def test_replaced_socket_cannot_dispatch_an_already_read_revocation(self):
        with tempfile.TemporaryDirectory(prefix='connection-', dir='/private/tmp') as directory:
            daemon = module.BridgeDaemon(Path(directory))
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda _: None
            daemon._ungroup_terminal_tasks = lambda *_: None
            read = module._read_line
            entered, resume = threading.Event(), threading.Event()
            connections, threads, errors = [], [], []

            def gated_read(reader):
                message = read(reader)
                if message.get('id') == 'old-revoke':
                    entered.set()
                    if not resume.wait(5):
                        raise RuntimeError('test gate timed out')
                return message

            def connect(label):
                client, server = socket.socketpair()
                client.settimeout(3)
                reader = client.makefile('rb')
                connections.extend([reader, client, server])
                def serve():
                    try:
                        with server.makefile('rb') as inbound:
                            daemon._serve_extension(server, inbound, 'chrome-extension://test/')
                    except (OSError, EOFError):
                        pass
                    except Exception as error:
                        errors.append(error)
                thread = threading.Thread(target=serve, daemon=True)
                threads.append(thread)
                thread.start()
                client.sendall(module._encode_line({'id': label, 'method': 'extension.hello',
                    'params': {'instanceId': 'browser', 'browser': 'chrome', 'version': 'test'}}))
                self.assertTrue(json.loads(reader.readline())['result']['connected'])
                return client

            with patch.object(module, '_read_line', gated_read):
                try:
                    old = connect('old')
                    old.sendall(module._encode_line({'id': 'old-revoke', 'method': 'extension.revoke_access', 'params': {}}))
                    self.assertTrue(entered.wait(3))
                    connect('replacement')
                    # 中文注释：新连接建立后的任务不能被旧连接迟到的无任务编号撤权消息取消。
                    task = daemon._dispatch_client('shared.create', {'owner': 'owner', 'title': 'replacement',
                        'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
                    resume.set()
                    threads[0].join(3)
                    self.assertFalse(threads[0].is_alive())
                    self.assertEqual(daemon.tasks[task['id']]['state'], 'pending_approval')
                    self.assertEqual(errors, [])
                finally:
                    resume.set()
                    for connection in connections:
                        if isinstance(connection, socket.socket):
                            try:
                                connection.shutdown(socket.SHUT_RDWR)
                            except OSError:
                                pass
                    for thread in threads:
                        thread.join(3)
                    for connection in connections:
                        connection.close()
