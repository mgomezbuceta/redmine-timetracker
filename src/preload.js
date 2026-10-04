const { contextBridge, ipcRenderer } = require('electron');

// Only these main-process channels can be called from the windows (defense in depth).
const CHANNELS = new Set([
  'activities:get', 'app:info', 'app:open', 'idle:resolve', 'issues:recent', 'issues:search', 'panel:open',
  'projects:list', 'review:get', 'review:submit', 'segments:addManual', 'segments:delete', 'segments:setComment',
  'segments:suggestStart', 'settings:clearKey', 'settings:get', 'settings:pickCa', 'settings:save', 'settings:test',
  'state:get', 'summary:get', 'timer:start', 'timer:toggle', 'update:check', 'update:dismiss', 'widget:menu'
]);

contextBridge.exposeInMainWorld('tt', {
  call: async (channel, ...args) => {
    if (!CHANNELS.has(channel)) throw new Error(`Canal no permitido: ${channel}`);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (channel, cb) => {
    if (!['state', 'tab'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  }
});
