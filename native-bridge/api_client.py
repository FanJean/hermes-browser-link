"""Cookie-only, pinned-address HTTP reads. No ambient proxy or cookie jar."""
from __future__ import annotations
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit


class ApiDenied(Exception):
    pass


class PinnedConnection(http.client.HTTPConnection):
    def connect(self):
        # A closed/cancelled transport must never fall back to hostname DNS.
        raise ApiDenied('implicit API connection denied')


def exact_url(url):
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in url):
        raise ApiDenied('invalid API URL')
    p = urlsplit(url)
    if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password or p.fragment or '\\' in url:
        raise ApiDenied('invalid API URL')
    try: p.port
    except ValueError: raise ApiDenied('invalid API URL') from None
    if p.netloc != p.netloc.lower(): raise ApiDenied('noncanonical API URL')
    return p


class ApiClient:
    def __init__(self, *, fixture=None):
        # Constructor-only, never read from environment, RPC, or daemon CLI.
        self.fixture = fixture
        if fixture is not None:
            o, prefix = fixture
            p = exact_url(o)
            if p.hostname != '127.0.0.1' or p.scheme != 'http' or p.path or p.query or not p.port or not re.fullmatch(r'/__hermes_api_fixture__/[a-f0-9]{32}/', prefix):
                raise ValueError('invalid isolated fixture policy')

    def target(self, url):
        p = exact_url(url)
        fixture = self.fixture and f'{p.scheme}://{p.netloc}' == self.fixture[0] and p.path.startswith(self.fixture[1])
        if not fixture and p.scheme != 'https': raise ApiDenied('HTTPS required')
        # Bound resolver execution without exposing DNS results or exception strings.
        import concurrent.futures
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            answers = pool.submit(socket.getaddrinfo, p.hostname, p.port or (443 if p.scheme == 'https' else 80), 0, socket.SOCK_STREAM).result(timeout=2)
        except Exception: raise ApiDenied('API DNS failed') from None
        finally: pool.shutdown(wait=False, cancel_futures=True)
        addresses = [a[4][0] for a in answers]
        if not addresses or any(not ipaddress.ip_address(a).is_global and not (fixture and a == '127.0.0.1') for a in addresses):
            raise ApiDenied('private network denied')
        return p, addresses[0]

    def request(self, url, method, fields, cookies, valid, track):
        if method not in ('GET', 'HEAD'): raise ApiDenied('read methods only')
        if not isinstance(fields, list) or not 1 <= len(fields) <= 16 or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', k) for k in fields):
            raise ApiDenied('explicit scalar fields required')
        p, address = self.target(url)
        if not isinstance(cookies, list) or len(cookies) > 128: raise ApiDenied('invalid credentials')
        pairs = []
        values = []
        for c in cookies:
            if not isinstance(c, dict): raise ApiDenied('invalid credentials')
            name, value = c.get('name'), c.get('value')
            if not isinstance(name, str) or not re.fullmatch(r'[!#$%&\'*+.^_`|~0-9A-Za-z-]+', name) or not isinstance(value, str) or any(ord(x) < 33 or ord(x) > 126 or x in ';,\\"' for x in value):
                raise ApiDenied('invalid credentials')
            pairs.append(name + '=' + value)
            if value: values.append(value)
        header = '; '.join(pairs)
        if len(header) > 16384: raise ApiDenied('credentials too large')
        port = p.port or (443 if p.scheme == 'https' else 80)
        conn = PinnedConnection(p.hostname, port, timeout=5)
        deadline = time.monotonic() + 5
        transport = []
        def interrupt():
            # HTTPResponse may detach its socket from HTTPConnection on close.
            for sock in transport:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
            conn.close()
        conn._api_abort = interrupt
        track(conn)
        timer = threading.Timer(5, interrupt)
        timer.daemon = True
        timer.start()
        try:
            if not valid(): raise ApiDenied('API authority revoked')
            conn.sock = socket.create_connection((address, port), timeout=5)
            transport.append(conn.sock)
            if p.scheme == 'https':
                conn.sock = ssl.create_default_context().wrap_socket(conn.sock, server_hostname=p.hostname)
                transport.append(conn.sock)
            if not valid() or time.monotonic() >= deadline: raise ApiDenied('API authority revoked or timed out')
            headers = {'Accept': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Hermes-Local-API/2'}
            if header: headers['Cookie'] = header
            conn.request(method, p.path + ('?' + p.query if p.query else '') or '/', headers=headers)
            response = conn.getresponse()
            if not 200 <= response.status < 300: raise ApiDenied('API non-success status')
            if method == 'HEAD': return {'status': response.status, 'data': {}}
            if response.getheader('Content-Encoding', 'identity') != 'identity': raise ApiDenied('compressed API body denied')
            if 'application/json' not in response.getheader('Content-Type', '').lower(): raise ApiDenied('JSON API required')
            body = bytearray()
            while True:
                if not valid() or time.monotonic() >= deadline: raise ApiDenied('API authority revoked or timed out')
                if conn.sock: conn.sock.settimeout(max(.001, deadline - time.monotonic()))
                chunk = response.read1(min(4096, 65537 - len(body)))
                if not chunk: break
                body.extend(chunk)
                if len(body) > 65536: raise ApiDenied('API body too large')
            obj = json.loads(body)
            if not isinstance(obj, dict): raise ApiDenied('JSON object required')
            data = {}
            for key in fields:
                v = obj.get(key)
                if key not in obj or isinstance(v, (dict, list)): continue
                if re.search('cookie|token|secret|password|authorization|session|csrf', key, re.I) or any(s in str(v) for s in values): v = '[REDACTED]'
                data[key] = v
            if len(json.dumps(data).encode()) > 8192: raise ApiDenied('filtered API output too large')
            if not valid(): raise ApiDenied('API authority revoked')
            return {'status': response.status, 'data': data}
        except ApiDenied: raise
        except Exception: raise ApiDenied('API request failed') from None
        finally:
            timer.cancel()
            interrupt()
            conn.close()
            pairs.clear(); values.clear(); header = ''
