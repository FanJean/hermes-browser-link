// 中文注释：固定函数由 Python helper 读取；参数单独序列化，沿用 js.evaluate 授权。
async (options) => {
  const url = new URL(options.url, location.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password)
    return {ok: false, code: 'origin_denied', dispatched: false};
  const sensitive = /cookie|authorization|password|passwd|secret|token|csrf|session|credential|otp|api.?key/i;
  let structureTruncated = false;
  const clean = (value, depth = 0) => {
    if (depth > 16) {structureTruncated = true; return '[TRUNCATED]';}
    if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? '[REDACTED]' : clean(v, depth + 1)]));
    return typeof value === 'string' ? value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]') : value;
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout_ms);
  try {
    // 中文注释：拒绝所有重定向，避免自动携带登录态请求另一个来源；不提供任意请求头接口。
    const response = await fetch(url.href, {method: options.method, credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: {Accept: 'application/json'}});
    const meta = {status: response.status, url: url.origin + url.pathname, filtered: true};
    if (!response.ok) {await response.body?.cancel(); return {...meta, ok: false, code: 'http_error', dispatched: true};}
    if (options.method === 'HEAD') return {...meta, ok: true, data: {}, complete: true};
    if (!/(?:application\/json|\+json)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); return {...meta, ok: false, code: 'non_json', dispatched: true};
    }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > options.max_bytes) {await reader.cancel(); return {...meta, ok: false, code: 'response_too_large', truncated: true, dispatched: true};}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    let parsed; try {parsed = JSON.parse(new TextDecoder().decode(bytes));}
    catch {return {...meta, ok: false, code: 'invalid_json', dispatched: true};}
    // 中文注释：字段名作为 JSON 数据处理，避免 __proto__ 触发原型 setter 而丢失结果。
    const data = Object.create(null), missingFields = [];
    for (const field of options.fields) {
      let value = parsed, found = true;
      for (const key of field.split('.')) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {found = false; break;}
        value = value[key];
      }
      if (found) data[field] = clean(value); else missingFields.push(field);
    }
    return {...meta, ok: true, data, missingFields, complete: missingFields.length === 0 && !structureTruncated, structureTruncated, bytes: size};
  } catch {return {ok: false, code: 'fetch_failed', dispatched: true, outcome_unknown: true};}
  finally {clearTimeout(timer);}
}
