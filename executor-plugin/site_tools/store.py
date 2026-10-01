"""中文注释：网站工具持久化；仅管理定义与验证记录，不另建浏览器执行器。"""
import ast
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
import uuid


class ToolError(ValueError):
    # 中文注释：稳定错误码用于恢复分支，异常文本不包含脚本或网页内容。
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def validate_schema(schema, depth=0):
    # 中文注释：支持固定 JSON Schema 子集；拒绝未实现的关键字，避免宣称校验成功。
    if depth > 8 or not isinstance(schema, dict) or set(schema) - {'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'maxItems', 'description'}:
        raise ToolError('invalid_schema')
    kind = schema.get('type')
    if kind not in {'object', 'array', 'string', 'integer', 'number', 'boolean', 'null'}:
        raise ToolError('invalid_schema')
    if kind == 'object':
        props = schema.get('properties', {})
        required = schema.get('required', [])
        if not isinstance(props, dict) or len(props) > 64 or not isinstance(required, list) or any(not isinstance(k, str) or k not in props for k in required) or schema.get('additionalProperties', False) is not False:
            raise ToolError('invalid_schema')
        for child in props.values():
            validate_schema(child, depth + 1)
    if kind == 'array':
        validate_schema(schema.get('items'), depth + 1)
    for key in ('minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'):
        if key in schema and (type(schema[key]) not in (int, float) or not __import__('math').isfinite(schema[key]) or key in {'minLength', 'maxLength', 'maxItems'} and (type(schema[key]) is not int or schema[key] < 0)):
            raise ToolError('invalid_schema')
    if 'enum' in schema and (not isinstance(schema['enum'], list) or not schema['enum']):
        raise ToolError('invalid_schema')


def validate_value(value, schema):
    kind = schema['type']
    valid = {'object': isinstance(value, dict), 'array': isinstance(value, list), 'string': isinstance(value, str),
             'integer': type(value) is int, 'number': type(value) in (int, float), 'boolean': type(value) is bool, 'null': value is None}[kind]
    if not valid or 'enum' in schema and not any(type(value) is type(v) and value == v for v in schema['enum']):
        raise ToolError('schema_mismatch')
    if kind == 'object':
        props = schema.get('properties', {})
        if set(value) - set(props) or set(schema.get('required', [])) - set(value):
            raise ToolError('schema_mismatch')
        for key, item in value.items():
            validate_value(item, props[key])
    if kind == 'array':
        if len(value) > schema.get('maxItems', 10000):
            raise ToolError('schema_mismatch')
        for item in value:
            validate_value(item, schema['items'])
    if kind == 'string' and not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', 20000):
        raise ToolError('schema_mismatch')
    if kind in {'integer', 'number'} and (not __import__('math').isfinite(value) or value < schema.get('minimum', float('-inf')) or value > schema.get('maximum', float('inf'))):
        raise ToolError('schema_mismatch')


def validate_definition(value):
    required = {'site', 'name', 'description', 'origins', 'access', 'args_schema', 'result_schema', 'code'}
    if not isinstance(value, dict) or set(value) != required:
        raise ToolError('invalid_definition')
    if any(not isinstance(value[k], str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value[k]) for k in ('site', 'name')):
        raise ToolError('invalid_definition')
    if value['access'] not in ('read', 'write') or not isinstance(value['description'], str) or not 1 <= len(value['description']) <= 1000:
        raise ToolError('invalid_definition')
    origins = value['origins']
    if not isinstance(origins, list) or not 1 <= len(origins) <= 16 or any(not isinstance(s, str) for s in origins):
        raise ToolError('invalid_definition')
    for origin in origins:
        parsed = urlsplit(origin)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path or origin != f'{parsed.scheme}://{parsed.netloc}':
            raise ToolError('invalid_definition')
    for key in ('args_schema', 'result_schema'):
        validate_schema(value[key])
    if value['args_schema']['type'] != 'object' or not isinstance(value['code'], str) or len(value['code']) > 100000:
        raise ToolError('invalid_definition')
    try:
        tree = ast.parse(value['code'])
    except SyntaxError as exc:
        raise ToolError('invalid_code') from exc
    # 中文注释：顶层仅允许 run 定义，避免定义阶段执行代码；函数仍是本机 Python，非沙箱。
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef) or tree.body[0].name != 'run':
        raise ToolError('invalid_code')
    fn = tree.body[0]
    if fn.decorator_list or fn.returns or fn.args.defaults or fn.args.kw_defaults or fn.args.kwonlyargs or fn.args.posonlyargs or fn.args.vararg or fn.args.kwarg or len(fn.args.args) != 1 or fn.args.args[0].arg != 'args' or fn.args.args[0].annotation:
        raise ToolError('invalid_code')


def check_result(value, checks):
    # 中文注释：断言只针对业务返回值；不存在与 null 分开，不接受空断言。
    if not isinstance(checks, list) or not 1 <= len(checks) <= 16:
        raise ToolError('invalid_checks')
    outcomes = []
    for check in checks:
        if not isinstance(check, dict) or set(check) - {'path', 'equals', 'min_items'} or not isinstance(check.get('path'), str):
            raise ToolError('invalid_checks')
        if 'min_items' in check and (type(check['min_items']) is not int or check['min_items'] < 0):
            raise ToolError('invalid_checks')
        current, found = value, True
        for key in check['path'].split('.') if check['path'] else []:
            if isinstance(current, dict) and key in current:
                current = current[key]
            elif isinstance(current, list) and key.isdigit() and int(key) < len(current):
                current = current[int(key)]
            else:
                found = False
                break
        passed = found
        if 'equals' in check:
            passed = passed and digest(current) == digest(check['equals'])
        if 'min_items' in check:
            passed = passed and isinstance(current, list) and len(current) >= check['min_items']
        outcomes.append({'path': check['path'], 'passed': passed})
    return {'passed': all(v['passed'] for v in outcomes), 'checks': outcomes}


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise ToolError('store_unsafe')
        os.chmod(self.root, 0o700)

    @contextmanager
    def locked(self):
        # 中文注释：跨进程非阻塞锁覆盖一次完整试运行，防止同时验证、启用或覆盖。
        fd = os.open(self.root / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ToolError('store_busy') from exc
            yield
        finally:
            os.close(fd)

    def read(self, name):
        path = self.root / (name + '.json')
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as stream:
                raw = stream.read(256000)
            return json.loads(raw)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            raise ToolError('store_corrupt') from exc

    def write(self, name, value):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(raw) > 250000:
            raise ToolError('definition_too_large')
        path = self.root / ('.' + uuid.uuid4().hex)
        try:
            with path.open('x') as stream:
                os.chmod(path, 0o600)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(path, self.root / (name + '.json'))
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def key(site, name):
        if any(not isinstance(s, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', s) for s in (site, name)):
            raise ToolError('invalid_name')
        return 'active-' + digest([site, name])

    def draft(self, draft_id):
        if not isinstance(draft_id, str) or not re.fullmatch('[0-9a-f]{32}', draft_id):
            raise ToolError('unknown_draft')
        record = self.read('draft-' + draft_id)
        if record is None:
            raise ToolError('unknown_draft')
        validate_definition(record['definition'])
        return record

    def define(self, definition):
        validate_definition(definition)
        with self.locked():
            previous = self.read(self.key(definition['site'], definition['name']))
            draft_id = uuid.uuid4().hex
            self.write('draft-' + draft_id, {'definition': definition, 'baseline': digest(previous), 'verified_digest': None, 'trials': []})
        return {'draft_id': draft_id, 'status': 'draft'}

    def trial(self, draft_id, args, checks, execute):
        # 中文注释：先校验断言，再执行可能有副作用的代码；失败立即使旧验证失效。
        check_result(None, checks)
        with self.locked():
            record = self.draft(draft_id)
            definition = record['definition']
            validate_value(args, definition['args_schema'])
            record['verified_digest'] = None
            self.write('draft-' + draft_id, record)
            result = execute(definition, args)
            validate_value(result, definition['result_schema'])
            verdict = check_result(result, checks)
            record['trials'] = (record['trials'] + [{'at': int(time.time()), 'args_digest': digest(args), 'passed': verdict['passed']}])[-16:]
            if verdict['passed']:
                record['verified_digest'] = digest(definition)
            self.write('draft-' + draft_id, record)
        return {'result': result, 'verification': verdict}

    def activate(self, draft_id):
        with self.locked():
            record = self.draft(draft_id)
            definition = record['definition']
            if not record['verified_digest']:
                raise ToolError('draft_not_verified')
            if record['verified_digest'] != digest(definition):
                raise ToolError('draft_changed')
            key = self.key(definition['site'], definition['name'])
            if digest(self.read(key)) != record['baseline']:
                raise ToolError('draft_conflict')
            revision = digest(definition)
            self.write(key, {'definition': definition, 'revision': revision, 'trials': record['trials']})
            (self.root / ('draft-' + draft_id + '.json')).unlink()
        return {'status': 'active', 'site': definition['site'], 'name': definition['name'], 'revision': revision}

    def discard(self, draft_id):
        with self.locked():
            self.draft(draft_id)
            (self.root / ('draft-' + draft_id + '.json')).unlink()
        return {'discarded': True}

    def get(self, site, name):
        with self.locked():
            record = self.read(self.key(site, name))
            if record is None:
                raise ToolError('unknown_tool')
            validate_definition(record['definition'])
            if record['revision'] != digest(record['definition']):
                raise ToolError('active_changed')
            return record

    def search(self, query='', limit=20):
        if not isinstance(query, str) or len(query) > 500 or type(limit) is not int or not 1 <= limit <= 100:
            raise ToolError('invalid_search')
        with self.locked():
            rows = []
            for path in sorted(self.root.glob('active-*.json')):
                record = self.read(path.stem)
                definition = record['definition']
                validate_definition(definition)
                if record['revision'] != digest(definition):
                    raise ToolError('active_changed')
                if all(term in ' '.join([definition['site'], definition['name'], definition['description'], *definition['origins']]).lower() for term in query.lower().split()):
                    rows.append({k: v for k, v in definition.items() if k != 'code'} | {'revision': record['revision']})
            return {'tools': rows[:limit], 'has_more': len(rows) > limit}
