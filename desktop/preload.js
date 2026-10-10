// Safe bridge between the web app and the desktop shell.
// The page can only call these three functions; main.js ignores them from any other website.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fmdDesktop', {
    ring: (info) => ipcRenderer.send('fmd:ring', {
        sos: !!(info && info.sos),
        title: String((info && info.title) || ''),
        body: String((info && info.body) || '')
    }),
    stop: () => ipcRenderer.send('fmd:stop'),
    retry: () => ipcRenderer.send('fmd:retry')
});