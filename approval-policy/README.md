# approval-policy

A pure, dependency-free decision function that tells the extension whether a page action is allowed, needs the user's confirmation, or is denied. It holds no I/O and never grants anything by itself.

## Modes

- **Smart approval** (default): reads (`tabs`, `snapshot`, `screenshot`) run automatically; navigation, interaction, data entry and destructive actions return `confirm`.
- **Full access**: after the user turns it on in the extension UI, supported actions run without repeated confirmation — but only within the same browser instance, task, owner, session, generations and tab leases. It never lifts origin checks, lease checks, sensitive-field checks or unsupported-action denials.

| Risk | Actions | Smart | Full access |
|---|---|---|---|
| read | `tabs`, `snapshot`, `screenshot` | allow | allow |
| navigation | `navigate`, `new_tab`, `select_tab` | confirm | allow |
| interaction | `click`, `ref_click` | confirm | allow |
| data entry | `fill`, `ref_fill`, `press` | confirm after the sensitive-field pre-check | allow after the pre-check |
| destructive | `close_tab` | confirm | allow |
| unsupported | anything else | deny | deny |

## API

```js
import { createApprovalPolicy, POLICY_VERSION } from './policy.mjs';

const policy = createApprovalPolicy({
  // Runs only at the trusted extension boundary: verify a real user gesture in
  // the extension UI, a single-use grant ID and an unrevoked token.
  verifyFullAccessGrant(grant, expectedScope) { /* ... */ },
});

let state = policy.createState({browserInstanceId, taskId, ownerId, sessionId, taskGeneration, connectionGeneration});
state = policy.enableFullAccess(state, {grantId, policyVersion: POLICY_VERSION, ...scope, expectedModeGeneration: state.modeGeneration});

const {decision, code, risk} = policy.decide(state, {action, tabId}, {
  ...scope, modeGeneration: state.modeGeneration, leasedTabIds, capabilities, targetAssessment,
});

state = policy.revokeFullAccess(state, 'user');   // back to smart, mode generation +1
state = policy.cancelTask(state);                 // permanently cancelled
state = policy.reconnect(state, nextScope);       // same instance/task/owner, authorization cleared
policy.decideReplay({action, outcome: 'unknown'}); // always {replay: false}
```

- `activeMode` always starts as `smart`. States are branded in-process objects; forged or deserialized states are rejected, so never persist `state` or grants.
- Scope and mode generation are checked before the external verifier is called, so a lenient verifier cannot widen a grant. Switching modes increments `modeGeneration` and invalidates older commands.
- Every scope field passed to `decide` must come from the trusted runtime, never from model or page input. Tab-lease checks cannot be disabled; only `tabs` and `new_tab` work without an existing lease.

## Tests

```sh
node --test approval-policy/test/policy.test.mjs
```
