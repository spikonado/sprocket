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
const STALE_UNAVAILABLE_WORKSPACE_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_PERSISTED_WORKSPACE_SESSIONS = 200;

let selectedWorkspace = isDevelopment ? process.cwd() : null;
let nativeBinding = null;
const workspaceSessions = new Map();
let workspaceSessionsLoaded = false;

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

function normalizeWorkspaceSessionState(input) {
	return {
		workspaceSessionId: input.workspaceSessionId,
		workspacePath: input.workspacePath,
		availability: input.availability === 'unavailable' ? 'unavailable' : 'available',
		lastValidatedAt: typeof input.lastValidatedAt === 'number' ? input.lastValidatedAt : Date.now(),
		lastUsedAt: typeof input.lastUsedAt === 'number' ? input.lastUsedAt : 0,
		...(typeof input.unavailableReason === 'string'
			? { unavailableReason: input.unavailableReason }
			: {})
	};
}

function getWorkspaceSessionsStorePath() {
	return path.join(app.getPath('userData'), 'workspace-sessions.json');
}

function loadWorkspaceSessionsFromDisk() {
	if (workspaceSessionsLoaded) {
		return;
	}

	workspaceSessionsLoaded = true;

	try {
		const storePath = getWorkspaceSessionsStorePath();
		if (!fs.existsSync(storePath)) {
			return;
		}

		const contents = fs.readFileSync(storePath, 'utf8');
		const storedSessions = JSON.parse(contents);
		if (!Array.isArray(storedSessions)) {
			return;
		}

		for (const entry of storedSessions) {
			if (
				!entry ||
				typeof entry.workspaceSessionId !== 'string' ||
				typeof entry.workspacePath !== 'string'
			) {
				continue;
			}

			workspaceSessions.set(
				entry.workspaceSessionId,
				normalizeWorkspaceSessionState({
					workspaceSessionId: entry.workspaceSessionId,
					workspacePath: entry.workspacePath,
					availability: entry.availability,
					lastValidatedAt: entry.lastValidatedAt,
					lastUsedAt: entry.lastUsedAt,
					unavailableReason: entry.unavailableReason
				})
			);
		}

		refreshWorkspaceSessions();
	} catch (error) {
		console.warn('Failed to load workspace sessions from disk', error);
	}
}

function saveWorkspaceSessionsToDisk() {
	loadWorkspaceSessionsFromDisk();
	pruneWorkspaceSessions();

	try {
		const storePath = getWorkspaceSessionsStorePath();
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, JSON.stringify([...workspaceSessions.values()], null, 2), 'utf8');
	} catch (error) {
		console.warn('Failed to save workspace sessions to disk', error);
	}
}

function getErrorMessage(error) {
	return error instanceof Error ? error.message : 'Unknown workspace error.';
}

function getWorkspaceOverviewForPath(workspacePath) {
	const nativeBinding = getNativeBinding();
	const overview = nativeBinding.getWorkspaceOverview(workspacePath);
	if (!overview?.rootPath) {
		throw new Error('Failed to resolve workspace path.');
	}

	return overview;
}

function validateWorkspaceSessionState(workspaceSession) {
	try {
		const overview = getWorkspaceOverviewForPath(workspaceSession.workspacePath);
		return {
			session: normalizeWorkspaceSessionState({
				...workspaceSession,
				workspacePath: overview.rootPath,
				availability: 'available',
				lastValidatedAt: Date.now(),
				unavailableReason: undefined
			}),
			overview
		};
	} catch (error) {
		return {
			session: normalizeWorkspaceSessionState({
				...workspaceSession,
				availability: 'unavailable',
				lastValidatedAt: Date.now(),
				unavailableReason: getErrorMessage(error)
			}),
			error
		};
	}
}

function refreshWorkspaceSessions() {
	let didChange = false;

	for (const [workspaceSessionId, workspaceSession] of workspaceSessions) {
		const { session } = validateWorkspaceSessionState(workspaceSession);
		if (JSON.stringify(session) === JSON.stringify(workspaceSession)) {
			continue;
		}

		workspaceSessions.set(workspaceSessionId, session);
		didChange = true;
	}

	if (didChange) {
		saveWorkspaceSessionsToDisk();
	}
}

function pruneWorkspaceSessions(now = Date.now()) {
	const sessions = [...workspaceSessions.values()]
		.filter((workspaceSession) => {
			if (workspaceSession.availability === 'available') {
				return true;
			}

			return now - workspaceSession.lastValidatedAt < STALE_UNAVAILABLE_WORKSPACE_MS;
		})
		.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
		.slice(0, MAX_PERSISTED_WORKSPACE_SESSIONS);

	workspaceSessions.clear();
	for (const workspaceSession of sessions) {
		workspaceSessions.set(workspaceSession.workspaceSessionId, workspaceSession);
	}
}

function attachWorkspaceSession(input) {
	loadWorkspaceSessionsFromDisk();

	const { session, error } = validateWorkspaceSessionState({
		workspaceSessionId: input.workspaceSessionId,
		workspacePath: input.workspacePath,
		availability: 'available',
		lastUsedAt: Date.now(),
		lastValidatedAt: Date.now()
	});
	workspaceSessions.set(session.workspaceSessionId, session);
	saveWorkspaceSessionsToDisk();

	if (error) {
		throw error;
	}

	selectedWorkspace = session.workspacePath;
	return session;
}

function getWorkspaceSessionOrThrow(workspaceSessionId) {
	loadWorkspaceSessionsFromDisk();

	const workspaceSession = workspaceSessions.get(workspaceSessionId);
	if (!workspaceSession) {
		throw new Error('Workspace path is unavailable. Re-open this workspace in the desktop app.');
	}

	return workspaceSession;
}

function getAttachedWorkspaceStateOrThrow(workspaceSessionId) {
	const workspaceSession = getWorkspaceSessionOrThrow(workspaceSessionId);
	const { session, overview, error } = validateWorkspaceSessionState(workspaceSession);
	session.lastUsedAt = Date.now();
	workspaceSessions.set(workspaceSessionId, session);
	saveWorkspaceSessionsToDisk();

	if (error || !overview) {
		throw new Error(session.unavailableReason ?? 'Workspace path is unavailable.');
	}

	selectedWorkspace = session.workspacePath;
	return {
		workspaceSession: session,
		overview
	};
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
		const overview = getWorkspaceOverviewForPath(result.filePaths[0]);
		selectedWorkspace = overview.rootPath;
		return overview;
	}

	return null;
});

ipcMain.handle('sprocket:list-workspace-sessions', () => {
	loadWorkspaceSessionsFromDisk();
	return [...workspaceSessions.values()];
});

ipcMain.handle('sprocket:attach-workspace-session', async (_event, session) => {
	return attachWorkspaceSession(session);
});

ipcMain.handle('sprocket:get-workspace-session-overview', async (_event, workspaceSessionId) => {
	return getAttachedWorkspaceStateOrThrow(workspaceSessionId).overview;
});

ipcMain.handle('sprocket:execute-workspace-tool', async (_event, request) => {
	const nativeBinding = getNativeBinding();
	const workspaceSessionId = request.workspaceSessionId;
	if (!workspaceSessionId) {
		throw new Error('No workspace session selected.');
	}
	const { workspaceSession } = getAttachedWorkspaceStateOrThrow(workspaceSessionId);
	const workspaceRoot = workspaceSession.workspacePath;

	switch (request.toolName) {
		case 'get_workspace_overview':
			return nativeBinding.getWorkspaceOverview(workspaceRoot);
		case 'get_workspace_instructions':
			return nativeBinding.getWorkspaceInstructions(workspaceRoot);
		case 'exec_command':
			return nativeBinding.execCommand({
				workspaceRoot,
				cmd: request.payload.cmd,
				...(request.payload.workdir == null ? {} : { workdir: request.payload.workdir }),
				...(request.payload.shell == null ? {} : { shell: request.payload.shell }),
				...(request.payload.login == null ? {} : { login: request.payload.login }),
				...(request.payload.timeoutMs == null ? {} : { timeoutMs: request.payload.timeoutMs }),
				...(request.payload.maxOutputChars == null
					? {}
					: { maxOutputChars: request.payload.maxOutputChars })
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
	const { workspaceSession } = getAttachedWorkspaceStateOrThrow(request.workspaceSessionId);

	return await nativeBinding.runAgent({
		...request,
		workspacePath: workspaceSession.workspacePath
	});
});

app.whenReady().then(() => {
	Menu.setApplicationMenu(null);
	loadRuntimeEnv();
	loadWorkspaceSessionsFromDisk();

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
