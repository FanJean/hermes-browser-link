export const POLICY_VERSION = 1;

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

const ACTIONS = Object.freeze({
  tabs: Object.freeze({ risk: 'read', requiresTabLease: false }),
  snapshot: Object.freeze({ risk: 'read', requiresTabLease: true }),
  screenshot: Object.freeze({ risk: 'read', requiresTabLease: true }),
  navigate: Object.freeze({ risk: 'navigation', requiresTabLease: true }),
  new_tab: Object.freeze({ risk: 'navigation', requiresTabLease: false }),
  select_tab: Object.freeze({ risk: 'navigation', requiresTabLease: true }),
  click: Object.freeze({ risk: 'interaction', requiresTabLease: true }),
  ref_click: Object.freeze({ risk: 'interaction', requiresTabLease: true }),
  ref_set_checked: Object.freeze({ risk: 'interaction', requiresTabLease: true }),
  ref_select_option: Object.freeze({ risk: 'interaction', requiresTabLease: true }),
  fill: Object.freeze({ risk: 'data_entry', requiresTabLease: true, requiresSafeFieldAssessment: true }),
  ref_fill: Object.freeze({ risk: 'data_entry', requiresTabLease: true, requiresSafeFieldAssessment: true }),
  // 中文注释：语义按键与选择器按键共用敏感字段预审和任务租约。
  ref_press: Object.freeze({ risk: 'data_entry', requiresTabLease: true, requiresSafeFieldAssessment: true }),
  // 中文注释：用户选定文件后才允许在任务页选择文件；具体来源由扩展再核实。
  'files.upload': Object.freeze({ risk: 'data_entry', requiresTabLease: true }),
  press: Object.freeze({ risk: 'data_entry', requiresTabLease: true, requiresSafeFieldAssessment: true }),
  close_tab: Object.freeze({ risk: 'destructive', requiresTabLease: true }),
});

const STRING_SCOPE_FIELDS = Object.freeze([
  'browserInstanceId',
  'taskId',
  'ownerId',
  'sessionId',
]);
const GENERATION_SCOPE_FIELDS = Object.freeze(['taskGeneration', 'connectionGeneration']);

const SCOPE_CHECKS = Object.freeze([
  Object.freeze(['browserInstanceId', 'BROWSER_INSTANCE_MISMATCH']),
  Object.freeze(['taskId', 'TASK_SCOPE_MISMATCH']),
  Object.freeze(['ownerId', 'OWNER_SCOPE_MISMATCH']),
  Object.freeze(['sessionId', 'SESSION_SCOPE_MISMATCH']),
  Object.freeze(['taskGeneration', 'TASK_GENERATION_MISMATCH']),
  Object.freeze(['connectionGeneration', 'CONNECTION_GENERATION_MISMATCH']),
]);

function deny(code, extra = {}) {
  return Object.freeze({ decision: 'deny', code, ...extra });
}

function validateScope(scope) {
  for (const field of STRING_SCOPE_FIELDS) {
    if (typeof scope?.[field] !== 'string' || scope[field].trim() === '') {
      throw new PolicyError('INVALID_SCOPE', `${field} must be a non-empty string`);
    }
  }
  for (const field of GENERATION_SCOPE_FIELDS) {
    if (!Number.isSafeInteger(scope?.[field]) || scope[field] < 0) {
      throw new PolicyError('INVALID_SCOPE', `${field} must be a non-negative safe integer`);
    }
  }
}

function freezeState(value) {
  Object.freeze(value.scope);
  return Object.freeze(value);
}

export function createApprovalPolicy({ verifyFullAccessGrant } = {}) {
  if (typeof verifyFullAccessGrant !== 'function') {
    throw new TypeError('verifyFullAccessGrant must be a function');
  }

  const states = new WeakSet();

  function issueState(data) {
    const state = freezeState(data);
    states.add(state);
    return state;
  }

  function classifyAction(actionName) {
    const action = ACTIONS[actionName];
    if (!action) {
      return Object.freeze({ supported: false, risk: 'unsupported', requiresTabLease: false });
    }
    return Object.freeze({
      supported: true,
      risk: action.risk,
      requiresTabLease: action.requiresTabLease,
    });
  }

  function createState(scope, { preferredMode = 'smart' } = {}) {
    validateScope(scope);
    if (!['smart', 'full'].includes(preferredMode)) {
      throw new PolicyError('INVALID_PREFERRED_MODE', 'preferredMode must be smart or full');
    }
    return issueState({
      policyVersion: POLICY_VERSION,
      preferredMode,
      activeMode: 'smart',
      modeGeneration: 1,
      lifecycle: 'active',
      scope: { ...scope },
      grant: null,
    });
  }

  function decideReplay({ action, outcome } = {}) {
    if (outcome === 'unknown') {
      return Object.freeze({ replay: false, code: 'UNKNOWN_OUTCOME_NO_REPLAY' });
    }
    if (!ACTIONS[action]) {
      return Object.freeze({ replay: false, code: 'UNSUPPORTED_ACTION' });
    }
    return Object.freeze({ replay: false, code: 'AUTOMATIC_REPLAY_DISABLED' });
  }

  function enableFullAccess(state, grant) {
    if (!states.has(state)) {
      throw new PolicyError('INVALID_POLICY_STATE', 'policy state was not issued by this engine');
    }
    if (state.lifecycle !== 'active') {
      throw new PolicyError('TASK_NOT_ACTIVE', 'inactive tasks cannot receive full access');
    }
    if (grant?.policyVersion !== POLICY_VERSION) {
      throw new PolicyError('GRANT_POLICY_VERSION_MISMATCH', 'grant policy version does not match');
    }
    for (const [field] of SCOPE_CHECKS) {
      if (grant?.[field] !== state.scope[field]) {
        throw new PolicyError('GRANT_SCOPE_MISMATCH', `${field} does not match the active scope`);
      }
    }
    if (grant?.expectedModeGeneration !== state.modeGeneration) {
      throw new PolicyError('GRANT_MODE_GENERATION_MISMATCH', 'grant was issued for another mode generation');
    }
    if (!verifyFullAccessGrant(grant, state.scope)) {
      throw new PolicyError('UNTRUSTED_GRANT', 'full access requires a trusted extension UI grant');
    }

    return issueState({
      ...state,
      activeMode: 'full',
      modeGeneration: state.modeGeneration + 1,
      grant: Object.freeze({ grantId: grant.grantId }),
    });
  }

  function revokeFullAccess(state, reason = 'user') {
    if (!states.has(state)) {
      throw new PolicyError('INVALID_POLICY_STATE', 'policy state was not issued by this engine');
    }

    return issueState({
      ...state,
      activeMode: 'smart',
      modeGeneration: state.modeGeneration + 1,
      grant: null,
      revocationReason: reason,
    });
  }

  function cancelTask(state) {
    if (!states.has(state)) {
      throw new PolicyError('INVALID_POLICY_STATE', 'policy state was not issued by this engine');
    }

    return issueState({
      ...state,
      activeMode: 'smart',
      modeGeneration: state.modeGeneration + 1,
      lifecycle: 'cancelled',
      grant: null,
      revocationReason: 'cancelled',
    });
  }

  function reconnect(state, nextScope) {
    if (!states.has(state)) {
      throw new PolicyError('INVALID_POLICY_STATE', 'policy state was not issued by this engine');
    }
    validateScope(nextScope);
    for (const field of ['browserInstanceId', 'taskId', 'ownerId']) {
      if (nextScope?.[field] !== state.scope[field]) {
        throw new PolicyError('RECONNECT_SCOPE_MISMATCH', `${field} cannot change during reconnect`);
      }
    }

    return issueState({
      ...state,
      activeMode: 'smart',
      modeGeneration: state.modeGeneration + 1,
      scope: { ...nextScope },
      grant: null,
      revocationReason: 'reconnect',
    });
  }

  function decide(state, request, runtime) {
    if (!states.has(state)) {
      return deny('INVALID_POLICY_STATE');
    }
    if (state.lifecycle !== 'active') {
      return deny('TASK_NOT_ACTIVE');
    }
    for (const [field, code] of SCOPE_CHECKS) {
      if (runtime?.[field] !== state.scope[field]) {
        return deny(code);
      }
    }
    if (runtime?.modeGeneration !== state.modeGeneration) {
      return deny('MODE_GENERATION_MISMATCH');
    }

    const action = ACTIONS[request?.action];
    if (!action) {
      return deny('UNSUPPORTED_ACTION');
    }

    if (runtime?.capabilities?.[request.action] !== true) {
      return deny('CAPABILITY_UNAVAILABLE', { risk: action.risk });
    }

    if (action.requiresTabLease && !runtime?.leasedTabIds?.includes(request.tabId)) {
      return deny('TAB_LEASE_REQUIRED', { risk: action.risk });
    }

    if (action.requiresSafeFieldAssessment) {
      if (runtime?.capabilities?.safeFieldEnforcement !== true) {
        return deny('CAPABILITY_UNAVAILABLE', {
          risk: action.risk,
          missingCapability: 'safeFieldEnforcement',
        });
      }
      if (runtime?.targetAssessment === 'sensitive') {
        return deny('SENSITIVE_TARGET', { risk: action.risk });
      }
      if (runtime?.targetAssessment !== 'ordinary') {
        return deny('TARGET_ASSESSMENT_REQUIRED', { risk: action.risk });
      }
    }

    if (action.risk === 'read') {
      return Object.freeze({
        decision: 'allow',
        code: 'SMART_READ_AUTO_ALLOWED',
        risk: action.risk,
        activeMode: state.activeMode,
        modeGeneration: state.modeGeneration,
        repeatApprovalRequired: false,
      });
    }

    if (state.activeMode === 'full') {
      return Object.freeze({
        decision: 'allow',
        code: 'FULL_ACCESS_SCOPE_ALLOWED',
        risk: action.risk,
        activeMode: state.activeMode,
        modeGeneration: state.modeGeneration,
        repeatApprovalRequired: false,
      });
    }

    return Object.freeze({
      decision: 'confirm',
      code: 'USER_CONFIRMATION_REQUIRED',
      risk: action.risk,
      activeMode: state.activeMode,
      modeGeneration: state.modeGeneration,
      repeatApprovalRequired: true,
    });
  }

  return Object.freeze({
    cancelTask,
    classifyAction,
    createState,
    decide,
    decideReplay,
    enableFullAccess,
    reconnect,
    revokeFullAccess,
  });
}
