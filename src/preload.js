const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tt', {
  call: async (channel, ...args) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (channel, cb) => {
    if (!['state', 'tab'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  }
});
