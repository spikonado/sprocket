import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const isDevelopment = !app.isPackaged;
const rendererUrl = process.env.SPROCKET_ELECTRON_RENDERER_URL ?? 'http://localhost:5173';
const preloadEntry = path.join(__dirname, 'preload.cjs');

let selectedWorkspace = isDevelopment ? process.cwd() : null;
let nativeBinding = null;

protocol.registerSchemesAsPrivileged([
	{
		scheme: 'sprocket',
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			allowServiceWorkers: true
		}
	}
]);

function getEnvFileCandidates() {
	const candidates = isDevelopment
		? [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../../.env')]
		: [
				path.resolve(process.cwd(), '.env'),
				path.join(app.getPath('userData'), '.env'),
				path.join(path.dirname(process.execPath), '.env'),
				process.env.APPIMAGE ? path.join(path.dirname(process.env.APPIMAGE), '.env') : null
			];

	const seen = new Set();

	return candidates.filter((candidate) => {
		if (!candidate || seen.has(candidate)) {
			return false;
		}

		seen.add(candidate);
		return true;
	});
}

function loadRuntimeEnv() {
	for (const envFile of getEnvFileCandidates()) {
		if (!fs.existsSync(envFile)) {
			continue;
		}

		try {
			process.loadEnvFile(envFile);
		} catch (error) {
			console.warn(`Failed to load environment from ${envFile}`, error);
		}
	}
}

function getNativeEntryPath() {
	return isDevelopment
		? path.resolve(__dirname, '../../packages/native/index.js')
		: path.join(__dirname, 'native', 'index.js');
}

function getNativeBinding() {
	loadRuntimeEnv();

	if (nativeBinding) {
		return nativeBinding;
	}

	const entryPath = getNativeEntryPath();
	nativeBinding = require(entryPath);
	return nativeBinding;
}

function createMainWindow() {
	const mainWindow = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 960,
		minHeight: 640,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadEntry
		}
	});
	mainWindow.webContents.on(
		'did-fail-load',
		(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			console.error('Renderer failed to load', {
				errorCode,
				errorDescription,
				validatedURL,
				isMainFrame
			});
		}
	);
	mainWindow.webContents.on('render-process-gone', (_event, details) => {
		console.error('Renderer process gone', details);
	});
	mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
		const levels = ['debug', 'info', 'warn', 'error'];
		const label = levels[level] ?? 'log';
		console.log(`[renderer:${label}] ${sourceId}:${line} ${message}`);
	});

	if (isDevelopment) {
		void mainWindow.loadURL(rendererUrl);
		mainWindow.webContents.openDevTools({ mode: 'detach' });
		return;
	}

	void mainWindow.loadURL('sprocket://app/');
}

ipcMain.handle('sprocket:choose-workspace', async () => {
	const result = await dialog.showOpenDialog({
		properties: ['openDirectory'],
		defaultPath: selectedWorkspace ?? app.getPath('home')
	});

	if (!result.canceled && result.filePaths[0]) {
		selectedWorkspace = result.filePaths[0];
	}

	return selectedWorkspace;
});

ipcMain.handle('sprocket:execute-workspace-tool', async (_event, request) => {
	const nativeBinding = getNativeBinding();
	const workspaceRoot = request.workspaceRoot ?? selectedWorkspace;
	if (!workspaceRoot) {
		throw new Error('No workspace selected.');
	}

	selectedWorkspace = workspaceRoot;

	switch (request.toolName) {
		case 'get_workspace_overview':
			return nativeBinding.getWorkspaceOverview(workspaceRoot);
		case 'get_workspace_instructions':
			return nativeBinding.getWorkspaceInstructions(workspaceRoot);
		case 'read_file':
			return nativeBinding.readFile({
				workspaceRoot,
				path: request.payload.path,
				...(request.payload.startLine == null ? {} : { startLine: request.payload.startLine }),
				...(request.payload.maxLines == null ? {} : { maxLines: request.payload.maxLines })
			});
		case 'create_file':
			return nativeBinding.createFile({
				workspaceRoot,
				path: request.payload.path,
				content: request.payload.content
			});
		case 'replace_in_file':
			return nativeBinding.replaceInFile({
				workspaceRoot,
				path: request.payload.path,
				oldText: request.payload.oldText,
				newText: request.payload.newText,
				...(request.payload.replaceAll == null ? {} : { replaceAll: request.payload.replaceAll })
			});
		default:
			throw new Error(`Unsupported workspace tool: ${request.toolName}`);
	}
});

ipcMain.handle('sprocket:run-agent', async (_event, request) => {
	const nativeBinding = getNativeBinding();
	return await nativeBinding.runAgent(request);
});

app.whenReady().then(() => {
	Menu.setApplicationMenu(null);
	loadRuntimeEnv();

	if (!isDevelopment) {
		const webDistDir = path.join(__dirname, 'web/dist');

		protocol.handle('sprocket', (request) => {
			const url = new URL(request.url);
			if (url.hostname !== 'app') {
				return new Response('Not Found', { status: 404 });
			}

			let pathname = url.pathname;
			if (pathname === '/' || pathname === '') {
				pathname = '/index.html';
			}

			const filePath = path.join(webDistDir, pathname);

			return net.fetch(pathToFileURL(filePath).toString()).catch(() => {
				return net.fetch(pathToFileURL(path.join(webDistDir, 'index.html')).toString());
			});
		});
	}

	createMainWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createMainWindow();
		}
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});
