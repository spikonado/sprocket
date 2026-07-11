const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sprocketDesktopBridge', {
	getLocalBootstrap: () => ipcRenderer.invoke('sprocket:get-local-bootstrap'),
	openExternal: (url) => ipcRenderer.invoke('sprocket:open-external', url),
	focusWindow: () => ipcRenderer.invoke('sprocket:focus-window')
});
