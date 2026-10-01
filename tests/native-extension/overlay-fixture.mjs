// Test-only synthetic automation overlay for CDP fixtures without a DOM.
//
// Production Executor refuses write actions when it cannot install the page
// overlay/highlight (INTERACTION_HIGHLIGHT_UNAVAILABLE). Fixtures that script
// CDP by hand therefore need a debugger with onEvent plus answers for the
// overlay's own functions. Every other call, including semantic calls that
// production runs in the overlay's world, is delegated to
// the wrapped fixture unchanged, so page-action assertions keep their meaning.
// This does not claim that highlight rendering works; DOM-backed coverage for
// that lives in tests/v1.1-highlight-*.
export const OVERLAY_CONTEXT_ID = 9001;

export function withSyntheticOverlay(debuggerApi, {calls = null} = {}) {
  const listeners = new Set();
  const sendCommand = debuggerApi.sendCommand;
  return {
    ...debuggerApi,
    onEvent: {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)},
    overlayListeners: listeners,
    sendCommand: async (target, method, params = {}) => {
      if (method === 'Page.createIsolatedWorld' && params.worldName === 'hermes-automation-overlay') {
        calls?.push(['overlay.createIsolatedWorld']);
        return {executionContextId: OVERLAY_CONTEXT_ID};
      }
      if (method === 'Runtime.addBinding' && params.executionContextId === OVERLAY_CONTEXT_ID) return {};
      if (method === 'Runtime.callFunctionOn' && params.executionContextId === OVERLAY_CONTEXT_ID) {
        const declaration = String(params.functionDeclaration || '');
        if (declaration.includes('createAutomationOverlay')) return {result: {value: true}};
        const op = params.arguments?.[0]?.value;
        if (declaration.startsWith('function interactionHighlightCommand')) {
          calls?.push(['overlay.highlight', op]);
          return {result: {value: {ok: true}}};
        }
        if (declaration.startsWith('function(op,scope){const state=globalThis.__hermesAutomationOverlay')) {
          calls?.push(['overlay', op]);
          return {result: {value: true}};
        }
        // Production reuses the overlay world for semantic calls; those stay
        // with the wrapped fixture.
      }
      return sendCommand(target, method, params);
    },
  };
}
