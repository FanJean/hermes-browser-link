import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('弹窗不再承载任务标签页选择', async () => {
  // 中文注释：任务数据只通过后台审批流程处理，工具栏弹窗不生成任务操作控件。
  const html = await readFile(new URL('../../native-extension/popup.html', import.meta.url), 'utf8')
  const script = await readFile(new URL('../../native-extension/popup.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(html, /data-tab-id|id="tasks"|id="detail"/)
  assert.doesNotMatch(script, /type:\s*'approve'|type:\s*'decide'|type:\s*'diagnostics_export'/)
})
