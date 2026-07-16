const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sprocketDesktopBridge', {
	getLocalBootstrap: () => ipcRenderer.invoke('sprocket:get-local-bootstrap'),
	takeWorkspaceLaunch: () => ipcRenderer.invoke('sprocket:take-workspace-launch'),
	onWorkspaceLaunch: (callback) => {
		const listener = () => callback();
		ipcRenderer.on('sprocket:workspace-launch', listener);
		return () => ipcRenderer.removeListener('sprocket:workspace-launch', listener);
	},
	openExternal: (url) => ipcRenderer.invoke('sprocket:open-external', url),
	focusWindow: () => ipcRenderer.invoke('sprocket:focus-window')
});
