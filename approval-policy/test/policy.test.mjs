import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalPolicy } from '../policy.mjs';

const scope = {
  browserInstanceId: 'edge-instance-1',
  taskId: 'task-1',
  ownerId: 'owner-1',
  sessionId: 'session-1',
  taskGeneration: 3,
  connectionGeneration: 8,
};

function grantFor(grantId, overrides = {}) {
  return {
    grantId,
    policyVersion: 1,
    ...scope,
    expectedModeGeneration: 1,
    ...overrides,
  };
}

function runtimeFor(state, overrides = {}) {
  return {
    ...scope,
    modeGeneration: state.modeGeneration,
    leasedTabIds: [41],
    capabilities: {
      tabs: true,
      snapshot: true,
      screenshot: true,
      navigate: true,
      new_tab: true,
      select_tab: true,
      click: true,
      ref_click: true,
      fill: true,
      ref_fill: true,
      press: true,
      close_tab: true,
      safeFieldEnforcement: true,
    },
    targetAssessment: 'ordinary',
    ...overrides,
  };
}

test('智能审批默认自动允许普通读取，风险操作要求确认', () => {
  const policy = createApprovalPolicy({ verifyFullAccessGrant: () => false });
  const state = policy.createState(scope);

  assert.equal(state.preferredMode, 'smart');
  assert.equal(state.activeMode, 'smart');
  assert.equal(policy.decide(state, { action: 'snapshot', tabId: 41 }, runtimeFor(state)).decision, 'allow');

  const click = policy.decide(state, { action: 'click', tabId: 41 }, runtimeFor(state));
  assert.equal(click.decision, 'confirm');
  assert.equal(click.code, 'USER_CONFIRMATION_REQUIRED');
  assert.equal(click.repeatApprovalRequired, true);
});

test('模型请求或伪造状态不能升权，只有受信扩展授权可启用完整访问', () => {
  const trustedGrant = grantFor('grant-1', { source: 'extension-ui' });
  const policy = createApprovalPolicy({
    verifyFullAccessGrant: (grant, expectedScope) =>
      grant === trustedGrant && grant.taskId === expectedScope.taskId,
  });
  const state = policy.createState(scope);

  const modelRequest = policy.decide(
    state,
    { action: 'click', tabId: 41, requestedMode: 'full' },
    runtimeFor(state),
  );
  assert.equal(modelRequest.decision, 'confirm');

  const forgedState = { ...state, activeMode: 'full' };
  assert.equal(
    policy.decide(forgedState, { action: 'click', tabId: 41 }, runtimeFor(state)).code,
    'INVALID_POLICY_STATE',
  );
  assert.throws(
    () => policy.enableFullAccess(state, { ...trustedGrant }),
    (error) => error.code === 'UNTRUSTED_GRANT',
  );

  const full = policy.enableFullAccess(state, trustedGrant);
  const decision = policy.decide(full, { action: 'click', tabId: 41 }, runtimeFor(full));
  assert.equal(full.activeMode, 'full');
  assert.equal(full.modeGeneration, 2);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.repeatApprovalRequired, false);
});

test('完整访问仍绑定浏览器实例、任务、会话、owner 与标签租约', () => {
  const trustedGrant = grantFor('grant-scope');
  const policy = createApprovalPolicy({ verifyFullAccessGrant: (grant) => grant === trustedGrant });
  const full = policy.enableFullAccess(policy.createState(scope), trustedGrant);
  const request = { action: 'click', tabId: 41 };

  const mismatches = [
    ['browserInstanceId', 'edge-instance-2', 'BROWSER_INSTANCE_MISMATCH'],
    ['taskId', 'task-2', 'TASK_SCOPE_MISMATCH'],
    ['ownerId', 'owner-2', 'OWNER_SCOPE_MISMATCH'],
    ['sessionId', 'session-2', 'SESSION_SCOPE_MISMATCH'],
    ['taskGeneration', 4, 'TASK_GENERATION_MISMATCH'],
    ['connectionGeneration', 9, 'CONNECTION_GENERATION_MISMATCH'],
    ['modeGeneration', full.modeGeneration - 1, 'MODE_GENERATION_MISMATCH'],
  ];

  for (const [field, value, code] of mismatches) {
    const result = policy.decide(full, request, runtimeFor(full, { [field]: value }));
    assert.equal(result.decision, 'deny', field);
    assert.equal(result.code, code, field);
  }

  const noLease = policy.decide(
    full,
    request,
    runtimeFor(full, { leasedTabIds: [], disableLeaseChecks: true }),
  );
  assert.equal(noLease.decision, 'deny');
  assert.equal(noLease.code, 'TAB_LEASE_REQUIRED');
});

test('持久化偏好不等于实际授权，撤销会失效旧代次', () => {
  const trustedGrant = grantFor('grant-revoke');
  const policy = createApprovalPolicy({ verifyFullAccessGrant: (grant) => grant === trustedGrant });
  const restored = policy.createState(scope, { preferredMode: 'full' });

  assert.equal(restored.preferredMode, 'full');
  assert.equal(restored.activeMode, 'smart');
  assert.equal(
    policy.decide(restored, { action: 'click', tabId: 41 }, runtimeFor(restored)).decision,
    'confirm',
  );

  const full = policy.enableFullAccess(restored, trustedGrant);
  const revoked = policy.revokeFullAccess(full, 'user');
  assert.equal(revoked.preferredMode, 'full');
  assert.equal(revoked.activeMode, 'smart');
  assert.equal(revoked.modeGeneration, full.modeGeneration + 1);
  assert.equal(revoked.grant, null);

  const stale = policy.decide(revoked, { action: 'snapshot', tabId: 41 }, runtimeFor(full));
  assert.equal(stale.decision, 'deny');
  assert.equal(stale.code, 'MODE_GENERATION_MISMATCH');

  const fresh = policy.decide(revoked, { action: 'click', tabId: 41 }, runtimeFor(revoked));
  assert.equal(fresh.decision, 'confirm');
});

test('重连保留偏好但清除完整访问并绑定新会话', () => {
  const trustedGrant = grantFor('grant-reconnect');
  const policy = createApprovalPolicy({ verifyFullAccessGrant: (grant) => grant === trustedGrant });
  const full = policy.enableFullAccess(
    policy.createState(scope, { preferredMode: 'full' }),
    trustedGrant,
  );
  const nextScope = {
    ...scope,
    sessionId: 'session-2',
    connectionGeneration: scope.connectionGeneration + 1,
  };

  const reconnected = policy.reconnect(full, nextScope);
  assert.equal(reconnected.preferredMode, 'full');
  assert.equal(reconnected.activeMode, 'smart');
  assert.equal(reconnected.grant, null);
  assert.equal(reconnected.scope.sessionId, 'session-2');
  assert.equal(reconnected.modeGeneration, full.modeGeneration + 1);

  const freshRuntime = runtimeFor(reconnected, {
    sessionId: 'session-2',
    connectionGeneration: scope.connectionGeneration + 1,
  });
  assert.equal(
    policy.decide(reconnected, { action: 'click', tabId: 41 }, freshRuntime).decision,
    'confirm',
  );
});

test('取消任务立即撤销授权且不能继续执行', () => {
  const trustedGrant = grantFor('grant-cancel');
  const policy = createApprovalPolicy({ verifyFullAccessGrant: (grant) => grant === trustedGrant });
  const full = policy.enableFullAccess(policy.createState(scope), trustedGrant);
  const cancelled = policy.cancelTask(full);

  assert.equal(cancelled.lifecycle, 'cancelled');
  assert.equal(cancelled.activeMode, 'smart');
  assert.equal(cancelled.grant, null);
  assert.equal(cancelled.modeGeneration, full.modeGeneration + 1);

  const decision = policy.decide(
    cancelled,
    { action: 'snapshot', tabId: 41 },
    runtimeFor(cancelled),
  );
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.code, 'TASK_NOT_ACTIVE');
  assert.throws(
    () => policy.enableFullAccess(
      cancelled,
      grantFor('grant-after-cancel', { expectedModeGeneration: cancelled.modeGeneration }),
    ),
    (error) => error.code === 'TASK_NOT_ACTIVE',
  );
});

test('动作风险分类是显式且可查询的', () => {
  const policy = createApprovalPolicy({ verifyFullAccessGrant: () => false });
  const expected = {
    tabs: 'read',
    snapshot: 'read',
    screenshot: 'read',
    navigate: 'navigation',
    new_tab: 'navigation',
    select_tab: 'navigation',
    click: 'interaction',
    ref_click: 'interaction',
    fill: 'data_entry',
    ref_fill: 'data_entry',
    press: 'data_entry',
    close_tab: 'destructive',
  };

  for (const [action, risk] of Object.entries(expected)) {
    assert.deepEqual(policy.classifyAction(action), {
      supported: true,
      risk,
      requiresTabLease: !['tabs', 'new_tab'].includes(action),
    });
  }
  assert.deepEqual(policy.classifyAction('evaluate'), {
    supported: false,
    risk: 'unsupported',
    requiresTabLease: false,
  });
});

test('完整访问不启用未支持动作，也不绕过敏感输入前置能力', () => {
  const trustedGrant = grantFor('grant-capability');
  const policy = createApprovalPolicy({ verifyFullAccessGrant: (grant) => grant === trustedGrant });
  const full = policy.enableFullAccess(policy.createState(scope), trustedGrant);

  const rawJs = policy.decide(
    full,
    { action: 'evaluate', tabId: 41 },
    runtimeFor(full, { capabilities: { ...runtimeFor(full).capabilities, evaluate: true } }),
  );
  assert.equal(rawJs.decision, 'deny');
  assert.equal(rawJs.code, 'UNSUPPORTED_ACTION');

  const noFieldGuard = policy.decide(
    full,
    { action: 'fill', tabId: 41 },
    runtimeFor(full, {
      capabilities: { ...runtimeFor(full).capabilities, safeFieldEnforcement: false },
    }),
  );
  assert.equal(noFieldGuard.decision, 'deny');
  assert.equal(noFieldGuard.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(noFieldGuard.missingCapability, 'safeFieldEnforcement');

  const sensitive = policy.decide(
    full,
    { action: 'fill', tabId: 41 },
    runtimeFor(full, { targetAssessment: 'sensitive' }),
  );
  assert.equal(sensitive.decision, 'deny');
  assert.equal(sensitive.code, 'SENSITIVE_TARGET');

  const ordinary = policy.decide(
    full,
    { action: 'fill', tabId: 41 },
    runtimeFor(full, { targetAssessment: 'ordinary' }),
  );
  assert.equal(ordinary.decision, 'allow');
});

test('未知执行结果一律不自动重放', () => {
  const policy = createApprovalPolicy({ verifyFullAccessGrant: () => false });

  for (const action of ['snapshot', 'click', 'fill']) {
    assert.deepEqual(policy.decideReplay({ action, outcome: 'unknown' }), {
      replay: false,
      code: 'UNKNOWN_OUTCOME_NO_REPLAY',
    });
  }
});

test('受信验证器也不能放宽授权的版本、会话或代次绑定', () => {
  const policy = createApprovalPolicy({ verifyFullAccessGrant: () => true });
  const state = policy.createState(scope);

  const cases = [
    [grantFor('wrong-version', { policyVersion: 2 }), 'GRANT_POLICY_VERSION_MISMATCH'],
    [grantFor('wrong-session', { sessionId: 'session-2' }), 'GRANT_SCOPE_MISMATCH'],
    [grantFor('wrong-generation', { expectedModeGeneration: 7 }), 'GRANT_MODE_GENERATION_MISMATCH'],
  ];

  for (const [grant, code] of cases) {
    assert.throws(
      () => policy.enableFullAccess(state, grant),
      (error) => error.code === code,
      code,
    );
  }
});

test('缺失 scope 或非法偏好在创建状态时直接失败', () => {
  const policy = createApprovalPolicy({ verifyFullAccessGrant: () => false });

  assert.throws(
    () => policy.createState({ ...scope, ownerId: '' }),
    (error) => error.code === 'INVALID_SCOPE',
  );
  assert.throws(
    () => policy.createState({ ...scope, connectionGeneration: -1 }),
    (error) => error.code === 'INVALID_SCOPE',
  );
  assert.throws(
    () => policy.createState(scope, { preferredMode: 'unrestricted' }),
    (error) => error.code === 'INVALID_PREFERRED_MODE',
  );
});
