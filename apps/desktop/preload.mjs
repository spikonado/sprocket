import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sprocketDesktop', {
	getNativeRuntimeInfo: () => ipcRenderer.invoke('native:get-runtime-info')
});
