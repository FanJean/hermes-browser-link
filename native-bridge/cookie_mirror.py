"""中文注释：独立内存通路；只向公开调用返回站点和计数，绝不调用持久化或诊断接口。"""
import ipaddress
import json
import re
import threading
import time
import uuid

CHUNK_LIMIT = 256 * 1024
TTL = 60.0
REASONS = {'expired', 'prefix_constraint', 'partition_write_failed', 'write_failed'}
SITE = re.compile(r'^(?:[a-z0-9-]+\.)*[a-z0-9-]+$')


class MirrorDenied(Exception):
    pass


def valid_site(site):
    if not isinstance(site, str) or len(site) > 253:
        return False
    if SITE.fullmatch(site):
        return True
    if site.startswith('[') and site.endswith(']'):
        try:
            ipaddress.IPv6Address(site[1:-1])
            return True
        except ValueError:
            pass
    return False


def selection(sites, options):
    if (not isinstance(sites, list) or not 1 <= len(sites) <= 256
            or any(not valid_site(s) for s in sites)
            or len(set(sites)) != len(sites)):
        raise MirrorDenied()
    if (not isinstance(options, dict) or set(options) - {'clearTarget', 'persistDays'}
            or 'clearTarget' in options and type(options['clearTarget']) is not bool
            or 'persistDays' in options and (type(options['persistDays']) is not int or not 1 <= options['persistDays'] <= 365)):
        raise MirrorDenied()


def number(value):
    if type(value) is not int or not 0 <= value <= 1000000:
        raise MirrorDenied()
    return value


def sites_view(value):
    rows = value.get('sites') if isinstance(value, dict) else None
    if not isinstance(rows, list) or len(rows) > 4096:
        raise MirrorDenied()
    result = []
    for row in rows:
        site = row.get('site') if isinstance(row, dict) else None
        if not valid_site(site):
            raise MirrorDenied()
        result.append({'site': site, 'count': number(row.get('count'))})
    if len({r['site'] for r in result}) != len(result):
        raise MirrorDenied()
    return result


class OneUseRelay:
    """中文注释：块取走立即删除；取消/超时会清空所有尚未取走的块。"""
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.chunks = {}
        self.spent = {}

    def put(self, transfer_id, index, value, deadline):
        with self.lock:
            if deadline <= self.clock() or (transfer_id, index) in self.chunks or (transfer_id, index) in self.spent:
                raise MirrorDenied()
            if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) > CHUNK_LIMIT - 8192:
                raise MirrorDenied()
            self.chunks[transfer_id, index] = (deadline, value)

    def take(self, transfer_id, index):
        with self.lock:
            deadline, value = self.chunks.pop((transfer_id, index), (0, None))
            if value is not None:
                self.spent[transfer_id, index] = deadline
            if deadline <= self.clock():
                raise MirrorDenied()
            return value

    def destroy(self, transfer_id):
        with self.lock:
            for key in list(self.chunks):
                if key[0] == transfer_id:
                    del self.chunks[key]

    def expire(self):
        with self.lock:
            for key, deadline in list(self.spent.items()):
                if deadline <= self.clock():
                    del self.spent[key]
            for key, (deadline, _) in list(self.chunks.items()):
                if deadline <= self.clock():
                    del self.chunks[key]


class CookieMirrorService:
    def __init__(self, daemon):
        self.daemon = daemon
        self.lock = threading.RLock()
        self.operations = {}
        self.relay = OneUseRelay()

    def extension(self, instance_id):
        with self.daemon.state_lock:
            ext = self.daemon.extensions.get(instance_id)
            if not ext or 'cookie_mirror_v1' not in ext.get('features', []):
                raise MirrorDenied()
            return ext

    def call(self, ext, action, params):
        # 中文注释：无论浏览器错误内容为何，只保留固定类别，异常不含浏览器返回文本。
        try:
            return self.daemon._extension_call(ext, 'browser.cookie_mirror.' + action, params, timeout=15)
        except Exception:
            raise MirrorDenied() from None

    def list_sites(self, source):
        return {'sites': sites_view(self.call(self.extension(source), 'list_sites', {}))}

    def request(self, params, owner):
        if set(params) - {'action', 'source', 'target', 'sites', 'options', 'owner'}:
            raise MirrorDenied()
        selection(params.get('sites'), params.get('options', {}))
        source, target = self.extension(params.get('source')), self.extension(params.get('target'))
        if source is target:
            raise MirrorDenied()
        with self.lock:
            # 中文注释：每端同一时刻只做一次镜像，避免清除/写入竞态及无界内存队列。
            if any(op['status'] in {'preparing', 'approval_required', 'executing'} and
                   ({op['source'], op['target']} & {source['instanceId'], target['instanceId']})
                   for op in self.operations.values()):
                raise MirrorDenied()
            if len(self.operations) >= 128:
                raise MirrorDenied()
            transfer_id = uuid.uuid4().hex
            op = {'transferId': transfer_id, 'owner': owner, 'source': source['instanceId'], 'target': target['instanceId'],
                  'sourceConnection': source, 'targetConnection': target, 'sites': list(params['sites']),
                  'options': dict(params.get('options', {})), 'status': 'preparing', 'deadline': time.monotonic() + TTL,
                  'expiresAt': time.time() + TTL, 'count': 0, 'rows': []}
            self.operations[transfer_id] = op
            timer = threading.Timer(TTL, self.expire, args=(transfer_id,))
            timer.daemon = True
            timer.start()
        threading.Thread(target=self.prepare, args=(op,), daemon=True).start()
        return self.view(op)

    def live(self, op, status=None):
        with self.lock:
            if (self.operations.get(op['transferId']) is not op or op['deadline'] <= time.monotonic()
                    or op['status'] not in {'preparing', 'approval_required', 'executing'}
                    or status and op['status'] != status):
                raise MirrorDenied()
        if self.extension(op['source']) is not op['sourceConnection'] or self.extension(op['target']) is not op['targetConnection']:
            raise MirrorDenied()

    def prepare(self, op):
        try:
            self.live(op, 'preparing')
            result = self.call(op['sourceConnection'], 'prepare', {
                'transferId': op['transferId'], 'expiresAt': op['expiresAt'] * 1000, 'sites': op['sites'], 'options': op['options'],
                'source': {'browser': op['sourceConnection']['browser'], 'instanceId': op['source']},
                'target': {'browser': op['targetConnection']['browser'], 'instanceId': op['target']}})
            rows = sites_view(result)
            chunks = number(result.get('chunks'))
            count = number(result.get('count'))
            if {r['site'] for r in rows} != set(op['sites']) or not 1 <= chunks <= 128 or count != sum(r['count'] for r in rows):
                raise MirrorDenied()
            self.live(op, 'preparing')
            with self.lock:
                if self.operations.get(op['transferId']) is not op or op['status'] != 'preparing' or op['deadline'] <= time.monotonic():
                    raise MirrorDenied()
                op.update(status='approval_required', rows=rows, count=count, chunks=chunks)
        except Exception:
            self.fail(op)

    def view(self, op):
        with self.lock:
            return {'transferId': op['transferId'], 'status': op['status'], 'source': op['source'], 'target': op['target'],
                    'count': op['count'], 'sites': [dict(row) for row in op['rows']],
                    **({'reason': op['reason']} if 'reason' in op else {}), **op.get('result', {})}

    def status(self, transfer_id, owner=None, source=None):
        with self.lock:
            op = self.operations.get(transfer_id)
            if not op or (owner is not None and op['owner'] != owner) or (source is not None and op['source'] != source):
                raise MirrorDenied()
            return self.view(op)

    def decide(self, source, params):
        if set(params) != {'transferId', 'approve'} or type(params['approve']) is not bool:
            raise MirrorDenied()
        with self.lock:
            op = self.operations.get(params['transferId'])
            if not op or op['source'] != source:
                raise MirrorDenied()
        self.live(op, 'approval_required')
        with self.lock:
            if op['status'] != 'approval_required' or op['deadline'] <= time.monotonic():
                raise MirrorDenied()
            op['status'] = 'executing' if params['approve'] else 'denied'
        if params['approve']:
            threading.Thread(target=self.execute, args=(op,), daemon=True).start()
        else:
            threading.Thread(target=self.destroy, args=(op,), daemon=True).start()
        return self.view(op)

    def execute(self, op):
        chunk = None
        try:
            self.live(op, 'executing')
            ready = self.call(op['targetConnection'], 'begin', {'transferId': op['transferId'], 'expiresAt': op['expiresAt'] * 1000,
                      'sites': op['sites'], 'options': op['options'], 'chunks': op['chunks']})
            if ready != {'ready': True}:
                raise MirrorDenied()
            for index in range(op['chunks']):
                self.live(op, 'executing')
                chunk = self.call(op['sourceConnection'], 'take', {'transferId': op['transferId'], 'index': index})
                if not isinstance(chunk, dict) or set(chunk) != {'index', 'cookies'} or chunk['index'] != index or not isinstance(chunk['cookies'], list):
                    raise MirrorDenied()
                self.relay.put(op['transferId'], index, chunk['cookies'], op['deadline'])
                chunk = None
                self.live(op, 'executing')
                chunk = self.relay.take(op['transferId'], index)
                result = self.call(op['targetConnection'], 'stage', {'transferId': op['transferId'], 'index': index, 'cookies': chunk})
                chunk = None
                if result != {'accepted': True}:
                    raise MirrorDenied()
            self.live(op, 'executing')
            raw = self.call(op['targetConnection'], 'finish', {'transferId': op['transferId']})
            result = self.result_view(raw, op)
            self.live(op, 'executing')
            with self.lock:
                if self.operations.get(op['transferId']) is not op or op['status'] != 'executing' or op['deadline'] <= time.monotonic():
                    raise MirrorDenied()
                op.update(status='completed', result=result)
        except Exception:
            self.fail(op)
        finally:
            chunk = None
            self.destroy(op)

    @staticmethod
    def result_view(raw, op):
        if not isinstance(raw, dict) or not isinstance(raw.get('sites'), list):
            raise MirrorDenied()
        rows = []
        for r in raw['sites']:
            if not isinstance(r, dict) or r.get('site') not in op['sites']:
                raise MirrorDenied()
            row = {'site': r['site'], **{key: number(r.get(key)) for key in ('success', 'failed', 'matched', 'missing', 'cleared', 'clearFailed')}}
            reasons = r.get('reasons')
            if not isinstance(reasons, dict) or set(reasons) - REASONS:
                raise MirrorDenied()
            row['reasons'] = {key: number(value) for key, value in reasons.items()}
            if row['matched'] + row['missing'] != row['success'] or sum(row['reasons'].values()) != row['failed']:
                raise MirrorDenied()
            rows.append(row)
        if len(rows) != len(op['sites']) or {r['site'] for r in rows} != set(op['sites']):
            raise MirrorDenied()
        sums = {key: sum(r[key] for r in rows) for key in ('success', 'failed', 'matched', 'missing')}
        if sums['success'] + sums['failed'] != op['count']:
            raise MirrorDenied()
        return {'sites': rows, **sums}

    def destroy(self, op):
        self.relay.destroy(op['transferId'])
        # 中文注释：先清内存块，再通知两端清除；通知失败不恢复或重放 Cookie。
        for key in ('sourceConnection', 'targetConnection'):
            try:
                self.call(op[key], 'destroy', {'transferId': op['transferId']})
            except MirrorDenied:
                pass

    def fail(self, op, reason='transfer_failed'):
        with self.lock:
            if op['status'] in {'preparing', 'approval_required', 'executing'}:
                op.update(status='failed', reason=reason)
        self.destroy(op)

    def expire(self, transfer_id):
        self.relay.expire()
        with self.lock:
            # 中文注释：截止时先删除元信息，清理通知的等待不能延长可查询或可批准时间。
            op = self.operations.pop(transfer_id, None)
        if op:
            self.fail(op, 'expired')

    def disconnected(self, instance_id):
        with self.lock:
            ops = [op for op in self.operations.values() if instance_id in {op['source'], op['target']}]
            for op in ops:
                if op['status'] in {'preparing', 'approval_required', 'executing'}:
                    op.update(status='failed', reason='disconnected')
                self.relay.destroy(op['transferId'])
        for op in ops:
            threading.Thread(target=self.destroy, args=(op,), daemon=True).start()

    def dispatch(self, params, owner):
        action = params.get('action')
        if action == 'list_sites' and set(params) == {'action', 'source', 'owner'}:
            return self.list_sites(params['source'])
        if action == 'request_mirror':
            return self.request(params, owner)
        if action == 'status' and set(params) == {'action', 'transferId', 'owner'}:
            return self.status(params['transferId'], owner=owner)
        raise MirrorDenied()
