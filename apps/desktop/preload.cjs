const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sprocketDesktop', {
	chooseWorkspace: () => ipcRenderer.invoke('sprocket:choose-workspace'),
	listWorkspaceSessions: () => ipcRenderer.invoke('sprocket:list-workspace-sessions'),
	attachWorkspaceSession: (session) =>
		ipcRenderer.invoke('sprocket:attach-workspace-session', session),
	getWorkspaceSessionOverview: (workspaceSessionId) =>
		ipcRenderer.invoke('sprocket:get-workspace-session-overview', workspaceSessionId),
	executeWorkspaceTool: (request) => ipcRenderer.invoke('sprocket:execute-workspace-tool', request),
	runAgent: (request) => ipcRenderer.invoke('sprocket:run-agent', request)
});
