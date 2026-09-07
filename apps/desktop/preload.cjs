const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sprocketDesktopBridge', {
	updates: {
		getState: () => ipcRenderer.invoke('sprocket:get-update-state'),
		download: () => ipcRenderer.invoke('sprocket:download-update'),
		install: () => ipcRenderer.invoke('sprocket:install-update'),
		onState: (callback) => {
			const listener = (_event, state) => callback(state);
			ipcRenderer.on('sprocket:update-state', listener);
			return () => ipcRenderer.removeListener('sprocket:update-state', listener);
		}
	},
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
