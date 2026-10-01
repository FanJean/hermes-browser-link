// 中文注释：保留方法分类供诊断；有效 CDP 方法的权限由浏览器模式审批统一决定。
const allow=(domain,methods,category='page')=>methods.split(/\s+/).filter(Boolean).map(name=>[`${domain}.${name}`,category]);

export const CDP_METHOD_POLICY=Object.freeze(Object.fromEntries([
 ...allow('Page','enable disable reload stopLoading getFrameTree getLayoutMetrics getNavigationHistory captureScreenshot printToPDF handleJavaScriptDialog bringToFront setLifecycleEventsEnabled getResourceTree getResourceContent createIsolatedWorld getAppManifest removeScriptToEvaluateOnNewDocument resetNavigationHistory'),
 ...allow('Page','navigate navigateToHistoryEntry','navigation'),
 // 中文注释：持久脚本需登记并在任务结束或撤权时移除。
 ...allow('Page','addScriptToEvaluateOnNewDocument','persistent_script'),
 ...allow('Runtime','enable disable evaluate callFunctionOn getProperties releaseObject releaseObjectGroup awaitPromise compileScript runScript globalLexicalScopeNames terminateExecution addBinding removeBinding discardConsoleEntries getExceptionDetails'),
 ...allow('DOM','enable disable getDocument getFlattenedDocument querySelector querySelectorAll describeNode resolveNode requestNode getBoxModel getContentQuads getOuterHTML setOuterHTML setAttributeValue setAttributesAsText removeAttribute removeNode setNodeValue setNodeName focus scrollIntoViewIfNeeded getNodeForLocation pushNodesByBackendIdsToFrontend pushNodeByPathToFrontend requestChildNodes performSearch getSearchResults discardSearchResults getAttributes markUndoableState undo redo collectClassNamesFromSubtree getFrameOwner copyTo moveTo insertAdjacentHTML getNodesForSubtreeByStyle'),
 ...allow('DOM','setFileInputFiles','file'),
 ...allow('Input','dispatchMouseEvent dispatchKeyEvent insertText dispatchTouchEvent dispatchDragEvent synthesizeScrollGesture synthesizeTapGesture synthesizePinchGesture imeSetComposition emulateTouchFromMouseEvent'),
 ...allow('Accessibility','enable disable getFullAXTree getPartialAXTree queryAXTree getChildAXNodes getRootAXNode getAXNodeAndAncestors'),
 ...allow('DOMSnapshot','enable disable captureSnapshot'),
 ...allow('CSS','enable disable getComputedStyleForNode getMatchedStylesForNode getInlineStylesForNode getBackgroundColors getPlatformFontsForNode'),
 ...allow('Overlay','enable disable highlightNode hideHighlight highlightRect highlightQuad'),
 ...allow('Emulation','setDeviceMetricsOverride clearDeviceMetricsOverride setEmulatedMedia setTouchEmulationEnabled setScrollbarsHidden setFocusEmulationEnabled setTimezoneOverride setLocaleOverride setUserAgentOverride setEmitTouchEventsForMouse setPageScaleFactor'),
 ...allow('Network','enable disable getResponseBody getRequestPostData setCacheDisabled emulateNetworkConditions setUserAgentOverride setBypassServiceWorker','network_observe'),
 ...allow('Log','enable disable clear'),
 ...allow('Console','enable disable clearMessages'),
 ...allow('Browser','getVersion'),
 // 中文注释：这些方法沿用分类标签，但不再形成第三层权限黑名单。
 ...allow('Network','getCookies getAllCookies setCookie setCookies deleteCookies clearBrowserCookies getCertificate','credential'),
 ...allow('Storage','getCookies setCookies clearCookies clearDataForOrigin clearDataForStorageKey getUsageAndQuota','credential'),
 ...allow('Network','setRequestInterception setBlockedURLs setExtraHTTPHeaders replayXHR clearBrowserCache setAttachDebugStack','interception'),
 ...allow('Fetch','enable disable continueRequest fulfillRequest failRequest continueWithAuth getResponseBody takeResponseBodyAsStream','interception'),
 ...allow('Browser','grantPermissions resetPermissions setPermission setDownloadBehavior close crash getBrowserCommandLine setWindowBounds getWindowForTarget','browser_global'),
 ...allow('Emulation','setGeolocationOverride clearGeolocationOverride setSensorOverrideEnabled setIdleOverride','permission'),
 ...allow('Page','setDownloadBehavior setBypassCSP setWebLifecycleState crash close','browser_global'),
 ...allow('Target','createTarget closeTarget attachToTarget detachFromTarget setAutoAttach setDiscoverTargets getTargets activateTarget createBrowserContext disposeBrowserContext exposeDevToolsProtocol sendMessageToTarget','target'),
 ...allow('Input','setIgnoreInputEvents','browser_global'),
]));

const SENSITIVE_HEADERS=new Set(['cookie','set-cookie','authorization','proxy-authorization']);

export function classifyCdpMethod(method){
 if(typeof method!=='string'||!/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/.test(method))return 'invalid';
 return CDP_METHOD_POLICY[method]||'unlisted';
}

export function cdpMethodAllowed(method){
 const category=classifyCdpMethod(method);
 // 中文注释：模式授权由调用链统一处理；有效 CDP 方法不再按旧权限类别拒绝。
 return {allowed:category!=='invalid',category};
}

function scrubHeaders(headers){
 if(!headers||typeof headers!=='object'||Array.isArray(headers))return headers;
 return Object.fromEntries(Object.entries(headers).filter(([name])=>!SENSITIVE_HEADERS.has(String(name).toLowerCase())));
}
// 中文注释：事件正文中直接出现的 Bearer 令牌也需脱敏，不能只依赖请求头名称。
function scrubBearer(value){
 if(typeof value==='string')return value.replace(/\bBearer\s+[^\s,;"']+/giu,'Bearer [redacted]');
 if(Array.isArray(value))return value.map(scrubBearer);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrubBearer(item)]));
 return value;
}

// 中文注释：转发事件前去掉凭据类请求头和扩展自身隔离世界的上下文，避免泄露插件内部状态。
export function scrubCdpEvent(method,params){
 if(method==='Runtime.executionContextCreated'&&/^hermes-/.test(params?.context?.name||''))return null;
 if(method==='Runtime.bindingCalled'&&String(params?.name||'').startsWith('hermes'))return null;
 if(!method.startsWith('Network.'))return scrubBearer(params);
 const copy=structuredClone(params||{});
 if(copy.request?.headers)copy.request.headers=scrubHeaders(copy.request.headers);
 if(copy.response?.headers)copy.response.headers=scrubHeaders(copy.response.headers);
 if(copy.response?.requestHeaders)copy.response.requestHeaders=scrubHeaders(copy.response.requestHeaders);
 if(copy.headers)copy.headers=scrubHeaders(copy.headers);
 if(copy.request?.headersText)delete copy.request.headersText;
 delete copy.response?.headersText;delete copy.response?.requestHeadersText;
 // 中文注释：握手与扩展事件的散列请求头同样剥离凭据，不丢弃整条跨来源事件。
 if(copy.requestHeaders)copy.requestHeaders=scrubHeaders(copy.requestHeaders);
 if(copy.responseHeaders)copy.responseHeaders=scrubHeaders(copy.responseHeaders);
 delete copy.headersText;delete copy.requestHeadersText;
 delete copy.associatedCookies;delete copy.blockedCookies;
 delete copy.request?.postDataEntries;
 return scrubBearer(copy);
}
