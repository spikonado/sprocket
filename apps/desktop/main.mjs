import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEV_API_PORT, DEV_WEB_URL, INSTALLED_APP_PORT } from './local-config.mjs';

const { app, BrowserWindow, dialog, Menu, ipcMain, shell } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDevelopment = !app.isPackaged;
const defaultServerPort = isDevelopment ? DEV_API_PORT : INSTALLED_APP_PORT;
const serverPort = Number(process.env.SPROCKET_PORT ?? defaultServerPort);
// Native AuthKit callbacks use the loopback IP; localhost is the canonical web-dev origin.
const serverHost = '127.0.0.1';
const desktopLoginCallbackUrl = `http://${serverHost}:${serverPort}/api/auth/desktop-login/callback`;
const devRendererUrl = process.env.SPROCKET_ELECTRON_RENDERER_URL ?? DEV_WEB_URL;
const rendererUrl = isDevelopment ? devRendererUrl : `http://${serverHost}:${serverPort}`;
const rendererOrigin = new URL(rendererUrl).origin;
const preloadEntry = path.join(__dirname, 'preload.cjs');

let serverProcess = null;
let serverBaseUrl = null;
let serverPairingCredential = null;
let serverDesktopLoginCallbackUrl = null;
let mainWindowRef = null;
let serverReadyPromise = null;
let isQuitting = false;
const initialWorkspaceLaunch = app.commandLine.getSwitchValue('sprocket-workspace').trim() || null;
const pendingWorkspaceLaunches = initialWorkspaceLaunch ? [initialWorkspaceLaunch] : [];

const hasSingleInstanceLock = app.requestSingleInstanceLock({
	workspacePath: initialWorkspaceLaunch
});
if (!hasSingleInstanceLock) {
	app.quit();
}

function isPlainObject(value) {
	return value !== null && !Array.isArray(value) && value === Object(value);
}

function parseNonEmptyString(value) {
	// Accepts only primitive non-empty strings (no boxed strings/arrays/objects).
	if (value === null || value === undefined || Array.isArray(value) || value === Object(value)) {
		return null;
	}
	if (value !== `${value}`) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parsePairingProof(value) {
	if (!isPlainObject(value)) {
		return null;
	}
	const httpBaseUrl = parseNonEmptyString(value.httpBaseUrl);
	if (
		httpBaseUrl === null ||
		(value.webUiEnabled !== true && value.webUiEnabled !== false) ||
		!Array.isArray(value.proof)
	) {
		return null;
	}
	return {
		httpBaseUrl,
		webUiEnabled: value.webUiEnabled,
		proof: value.proof
	};
}

function parseDesktopBootstrap(value) {
	if (!isPlainObject(value)) {
		return null;
	}
	const pairingCredential = parseNonEmptyString(value.pairingCredential);
	if (pairingCredential === null) {
		return null;
	}
	return {
		pairingCredential,
		httpBaseUrl: parseNonEmptyString(value.httpBaseUrl),
		desktopLoginCallbackUrl: parseNonEmptyString(value.desktopLoginCallbackUrl)
	};
}

function reportFatalError(title, error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(title, error);
	if (app.isReady()) {
		dialog.showErrorBox(title, message);
	}
}

function requireTrustedRenderer(event) {
	let senderOrigin;
	try {
		senderOrigin = new URL(event.senderFrame.url).origin;
	} catch {
		throw new Error('Untrusted renderer request.');
	}
	if (senderOrigin !== rendererOrigin) {
		throw new Error('Untrusted renderer request.');
	}
}

function getServerBinaryPath() {
	if (isDevelopment) {
		return path.resolve(__dirname, '../../target/debug/sprocket');
	}

	const executableName = process.platform === 'win32' ? 'sprocket.exe' : 'sprocket';
	return path.join(process.resourcesPath, 'server', executableName);
}

function getDefaultDataDir() {
	const home = process.env.HOME || process.env.USERPROFILE || '.';
	return path.join(home, '.sprocket');
}

function getLocalDataDir() {
	const configured = process.env.SPROCKET_DATA_DIR?.trim();
	if (configured) {
		return path.resolve(configured);
	}

	return isDevelopment ? path.resolve(__dirname, '../../.sprocket-dev') : getDefaultDataDir();
}

function waitForServerReady(baseUrl, timeoutMs = 30_000) {
	const startedAt = Date.now();

	return new Promise((resolve, reject) => {
		const poll = async () => {
			try {
				const response = await fetch(`${baseUrl}/api/health`);
				if (response.ok) {
					resolve(undefined);
					return;
				}
			} catch {
				// Server is still starting.
			}

			if (Date.now() - startedAt > timeoutMs) {
				reject(new Error('Timed out waiting for the Sprocket local server.'));
				return;
			}

			setTimeout(() => {
				void poll();
			}, 200);
		};

		void poll();
	});
}

async function attachToRunningServer(baseUrl, dataDir) {
	const challenge = randomUUID();
	let response;
	try {
		response = await fetch(`${baseUrl}/api/auth/pairing-proof`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ challenge }),
			signal: AbortSignal.timeout(750)
		});
	} catch (error) {
		if (error?.cause?.code === 'ECONNREFUSED') {
			return false;
		}
		throw new Error(`Failed to check the service at ${baseUrl}.`, { cause: error });
	}

	if (!response.ok) {
		throw new Error(`Port ${serverPort} is already used by another service.`);
	}

	const pairingProof = parsePairingProof(await response.json());
	if (pairingProof === null || pairingProof.httpBaseUrl !== baseUrl) {
		throw new Error(`The service at ${baseUrl} is not a compatible Sprocket server.`);
	}
	if (!isDevelopment && !pairingProof.webUiEnabled) {
		throw new Error(`The Sprocket server at ${baseUrl} is running in API-only mode.`);
	}

	let pairingCredential;
	try {
		pairingCredential = fs.readFileSync(path.join(dataDir, 'pairing-credential'), 'utf8').trim();
	} catch (error) {
		throw new Error(
			`The Sprocket server at ${baseUrl} uses a different data directory. Set SPROCKET_DATA_DIR to match it.`,
			{ cause: error }
		);
	}
	if (!pairingCredential) {
		throw new Error(`The pairing credential in ${dataDir} is empty.`);
	}

	const message = `${challenge}\n${pairingProof.httpBaseUrl}\nweb-ui=${pairingProof.webUiEnabled}`;
	const expectedProof = createHmac('sha256', pairingCredential).update(message).digest();
	const receivedProof = Buffer.from(pairingProof.proof);
	if (
		receivedProof.length !== expectedProof.length ||
		!timingSafeEqual(receivedProof, expectedProof)
	) {
		throw new Error(
			`The Sprocket server at ${baseUrl} uses a different data directory. Set SPROCKET_DATA_DIR to match it.`
		);
	}

	serverBaseUrl = pairingProof.httpBaseUrl;
	serverPairingCredential = pairingCredential;
	serverDesktopLoginCallbackUrl = desktopLoginCallbackUrl;
	return true;
}

async function startLocalServer() {
	if (serverBaseUrl) {
		return serverBaseUrl;
	}

	const port = serverPort;
	const host = serverHost;
	const dataDir = getLocalDataDir();
	const serverBinary = getServerBinaryPath();
	// extraResources (not asar): the Rust server must read these from disk.
	const staticDir = isDevelopment ? undefined : path.join(process.resourcesPath, 'web');
	const fallbackBaseUrl = `http://${host}:${port}`;
	if (await attachToRunningServer(fallbackBaseUrl, dataDir)) {
		return serverBaseUrl;
	}

	const desktopBootstrapToken = randomUUID();
	const args = [
		'serve',
		'--quiet',
		...(isDevelopment ? ['--api-only'] : []),
		'--host',
		host,
		'--port',
		String(port),
		'--data-dir',
		dataDir,
		...(staticDir ? ['--static-dir', staticDir] : [])
	];

	const serverEnv = {
		...process.env,
		SPROCKET_HOST: host,
		SPROCKET_PORT: String(port),
		SPROCKET_DATA_DIR: dataDir,
		SPROCKET_DESKTOP_BOOTSTRAP_TOKEN: desktopBootstrapToken
	};
	if (staticDir) {
		serverEnv.SPROCKET_STATIC_DIR = staticDir;
	}

	serverProcess = spawn(serverBinary, args, {
		env: serverEnv,
		stdio: ['ignore', 'pipe', 'inherit']
	});
	serverProcess.once('error', (error) => {
		if (!isQuitting) {
			reportFatalError('Failed to start Sprocket server', error);
			app.quit();
		}
	});

	serverProcess.stdout?.on('data', (chunk) => {
		const text = chunk.toString();
		process.stdout.write(text);
		const match = text.match(/SPROCKET_LISTENING=(.+)/);
		if (match?.[1]) {
			serverBaseUrl = match[1].trim();
		}
	});

	serverProcess.on('exit', (code, signal) => {
		if (signal) {
			console.warn(`Sprocket local server exited via signal ${signal}`);
		} else if (code && code !== 0) {
			console.error(`Sprocket local server exited with code ${code}`);
		}

		if (!isQuitting) {
			reportFatalError(
				'Sprocket server stopped',
				new Error(
					signal
						? `The local server exited via signal ${signal}.`
						: `The local server exited with code ${code ?? 0}.`
				)
			);
			app.quit();
		}
	});

	await waitForServerReady(fallbackBaseUrl);
	serverBaseUrl ??= fallbackBaseUrl;

	const bootstrapResponse = await fetch(`${serverBaseUrl}/api/auth/desktop-bootstrap`, {
		headers: {
			'x-sprocket-desktop-bootstrap-token': desktopBootstrapToken
		}
	});
	if (!bootstrapResponse.ok) {
		throw new Error('Failed to load desktop bootstrap details from the local server.');
	}

	const bootstrap = parseDesktopBootstrap(await bootstrapResponse.json());
	if (bootstrap === null) {
		throw new Error('Failed to load desktop bootstrap details from the local server.');
	}
	serverPairingCredential = bootstrap.pairingCredential;
	serverBaseUrl = bootstrap.httpBaseUrl ?? serverBaseUrl;
	serverDesktopLoginCallbackUrl = bootstrap.desktopLoginCallbackUrl ?? desktopLoginCallbackUrl;

	return serverBaseUrl;
}

function stopLocalServer() {
	if (!serverProcess || serverProcess.killed) {
		return;
	}

	serverProcess.kill();
	serverProcess = null;
}

function queueWorkspaceLaunch(workspacePath) {
	const parsed = parseNonEmptyString(workspacePath);
	if (parsed === null) {
		return;
	}

	pendingWorkspaceLaunches.push(parsed);
	notifyWorkspaceLaunch();
}

function notifyWorkspaceLaunch() {
	if (pendingWorkspaceLaunches.length === 0) {
		return;
	}

	const mainWindow = mainWindowRef;
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('sprocket:workspace-launch');
	}
}

async function showDesktopApp() {
	if (!serverReadyPromise) {
		throw new Error('Local server startup is unavailable.');
	}
	await serverReadyPromise;

	const mainWindow = mainWindowRef;
	if (!mainWindow || mainWindow.isDestroyed()) {
		createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	mainWindow.show();
	mainWindow.focus();
}

async function loadRendererWhenReady(mainWindow, targetUrl, timeoutMs = 60_000) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			await mainWindow.loadURL(targetUrl);
			return;
		} catch (error) {
			if (Date.now() - startedAt > timeoutMs - 500) {
				throw error;
			}

			await new Promise((resolve) => {
				setTimeout(resolve, 500);
			});
		}
	}

	throw new Error(`Timed out waiting for the renderer at ${targetUrl}.`);
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
	mainWindowRef = mainWindow;
	mainWindow.on('closed', () => {
		if (mainWindowRef === mainWindow) {
			mainWindowRef = null;
		}
	});
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void openExternalHttpsUrl(url).catch((error) => {
			console.error('Failed to open external URL', error);
		});
		return { action: 'deny' };
	});
	const preventUntrustedNavigation = (event, url) => {
		if (new URL(url).origin !== rendererOrigin) {
			event.preventDefault();
		}
	};
	mainWindow.webContents.on('will-navigate', preventUntrustedNavigation);
	mainWindow.webContents.on('will-redirect', preventUntrustedNavigation);
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
	mainWindow.webContents.on('did-finish-load', notifyWorkspaceLaunch);
	mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
		console.log(`[renderer:${level}] ${sourceId}:${lineNumber} ${message}`);
	});

	void loadRendererWhenReady(mainWindow, rendererUrl).catch((error) => {
		reportFatalError('Failed to load Sprocket', error);
		app.quit();
	});
	if (isDevelopment) {
		mainWindow.webContents.openDevTools({ mode: 'detach' });
	}
}

ipcMain.handle('sprocket:get-local-bootstrap', (event) => {
	requireTrustedRenderer(event);
	if (!serverBaseUrl || !serverPairingCredential) {
		throw new Error('Local server bootstrap is unavailable.');
	}

	return {
		httpBaseUrl: serverBaseUrl,
		desktopLoginCallbackUrl: serverDesktopLoginCallbackUrl ?? desktopLoginCallbackUrl,
		pairingCredential: serverPairingCredential
	};
});

ipcMain.handle('sprocket:take-workspace-launch', (event) => {
	requireTrustedRenderer(event);
	return pendingWorkspaceLaunches.shift() ?? null;
});

function openWithXdgOpen(url) {
	return new Promise((resolve, reject) => {
		const systemOpeners = [
			'/run/current-system/sw/bin/xdg-open',
			'/usr/bin/xdg-open',
			'/usr/local/bin/xdg-open'
		];
		const openerCommand = systemOpeners.find((candidate) => fs.existsSync(candidate)) ?? 'xdg-open';
		const openerEnv = { ...process.env };
		for (const key of [
			'GIO_EXTRA_MODULES',
			'GI_TYPELIB_PATH',
			'GSETTINGS_SCHEMA_DIR',
			'GTK_PATH',
			'LD_LIBRARY_PATH'
		]) {
			delete openerEnv[key];
		}
		const opener = spawn(openerCommand, [url], {
			env: openerEnv,
			stdio: ['ignore', 'ignore', 'pipe']
		});
		let stderr = '';

		opener.once('error', reject);
		opener.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		opener.once('close', (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}

			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			const details = stderr.trim();
			reject(new Error(`xdg-open failed with ${reason}${details ? `: ${details}` : ''}`));
		});
	});
}

function parseExternalHttpsUrl(url) {
	const raw = parseNonEmptyString(url);
	if (raw === null) {
		throw new Error('A URL is required.');
	}

	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error('Invalid URL.');
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('Only https URLs can be opened externally.');
	}

	return parsed.toString();
}

async function openExternalHttpsUrl(url) {
	const parsedUrl = parseExternalHttpsUrl(url);
	await openInSystemBrowser(parsedUrl);
}

async function openInSystemBrowser(url) {
	if (process.platform === 'linux') {
		await openWithXdgOpen(url);
		return;
	}

	await shell.openExternal(url);
}

ipcMain.handle('sprocket:open-external', async (event, url) => {
	requireTrustedRenderer(event);
	await openExternalHttpsUrl(url);
});

ipcMain.handle('sprocket:focus-window', (event) => {
	requireTrustedRenderer(event);
	const mainWindow = mainWindowRef;
	if (!mainWindow || mainWindow.isDestroyed()) {
		return false;
	}

	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	mainWindow.show();
	mainWindow.focus();
	return true;
});

if (hasSingleInstanceLock) {
	app.on('second-instance', (_event, _commandLine, _workingDirectory, additionalData) => {
		queueWorkspaceLaunch(additionalData?.workspacePath);
		void showDesktopApp().catch((error) => {
			console.error('Failed to handle Sprocket launch request', error);
		});
	});

	serverReadyPromise = app.whenReady().then(async () => {
		Menu.setApplicationMenu(null);
		await startLocalServer();
	});

	void serverReadyPromise
		.then(() => showDesktopApp())
		.catch((error) => {
			reportFatalError('Failed to start Sprocket', error);
			app.quit();
		});

	app.on('activate', () => {
		void showDesktopApp().catch((error) => {
			console.error('Failed to show Sprocket desktop app', error);
		});
	});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('before-quit', () => {
	isQuitting = true;
	stopLocalServer();
});
