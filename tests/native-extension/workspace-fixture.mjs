import assert from 'node:assert/strict';

// Trusted approval metadata is installed via Executor.approve, never execute payloads.
export const trustedTask = (id = 'a', tabIds = [1]) => ({
  id, instanceId: 'fixture-browser-instance', approvalScope: `fixture-owner-${id}`,
  generation: 1, state: 'ready', allowedOrigins: ['https://example.com'], tabIds,
});

// In-memory Chrome API boundary only: use the real Executor/workspace authority/manager.
// 中文注释：批量建页用例可从较高 ID 开始，避免合成 ID 撞上初始用户页。
export function workspaceFixture({nextTabId=3}={}) {
  const tabs = new Map([
    [1, {id: 1, url: 'https://example.com/', windowId: 7, groupId: -1, active: true}],
    [9, {id: 9, url: 'https://evil.test/', windowId: 7, groupId: -1, active: false}],
  ]);
  const groupInfo = new Map();
  const data = {}, creates = [], groups = [], removed = [];
  let nextTab = nextTabId, nextGroup = 20;
  const api = {
    storage: {local: {
      get: async key => structuredClone({[key]: data[key]}),
      set: async values => Object.assign(data, structuredClone(values)),
    }},
    windows: {getCurrent: async () => ({id: 7})},
    tabs: {
      query: async () => [...tabs.values()].map(tab => ({...tab})),
      get: async id => {
        assert.ok(tabs.has(id), `missing fixture tab ${id}`);
        return {...tabs.get(id)};
      },
      create: async params => {
        assert.equal(params.active, false);
        assert.equal(params.windowId, 7);
        creates.push({...params});
        const tab = {...params, id: nextTab++, groupId: -1};
        tabs.set(tab.id, tab);
        return {...tab};
      },
      group: async params => {
        groups.push(structuredClone(params));
        const groupId = params.groupId ?? nextGroup++;
        for (const id of params.tabIds) {
          const tab = tabs.get(id);
          assert.ok(tab);
          if (params.createProperties) assert.equal(tab.windowId, params.createProperties.windowId);
          tab.groupId = groupId;
        }
        return groupId;
      },
      remove: async id => {assert.ok(tabs.has(id)); removed.push(id); tabs.delete(id);},
    },
    // 中文注释：组标题查询参与归属复核，fixture 保留真实更新结果。
    tabGroups: {update: async (id, properties) => {groupInfo.set(id,{id,windowId:7,...properties});}, get:async id=>({...groupInfo.get(id)})},
    debugger: {detach: async () => {}},
  };
  return {api, tabs, data, creates, groups, removed};
}
