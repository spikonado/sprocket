const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sprocketDesktop', {
	chooseWorkspace: () => ipcRenderer.invoke('sprocket:choose-workspace'),
	executeWorkspaceTool: (request) => ipcRenderer.invoke('sprocket:execute-workspace-tool', request),
	runAgent: (request) => ipcRenderer.invoke('sprocket:run-agent', request)
});
