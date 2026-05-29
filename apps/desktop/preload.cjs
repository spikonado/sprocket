const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sprocketDesktopBridge', {
	getLocalBootstrap: () => ipcRenderer.invoke('sprocket:get-local-bootstrap')
});
