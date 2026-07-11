import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { API_PORT, DEV_WEB_URL } from '../../scripts/dev-config.mjs';

const { app, BrowserWindow, Menu, ipcMain, shell } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDevelopment = !app.isPackaged;
const serverPort = Number(process.env.SPROCKET_PORT ?? API_PORT);
// WorkOS AuthKit only allows 127.0.0.1 loopback redirect URIs for native desktop login.
const serverHost = '127.0.0.1';
const desktopLoginCallbackUrl = `http://${serverHost}:${serverPort}/api/auth/desktop-login/callback`;
const devRendererUrl = process.env.SPROCKET_ELECTRON_RENDERER_URL ?? DEV_WEB_URL;
const preloadEntry = path.join(__dirname, 'preload.cjs');

let serverProcess = null;
let serverBaseUrl = null;
let serverPairingCredential = null;
let serverDesktopLoginCallbackUrl = null;
let mainWindowRef = null;

function getServerBinaryPath() {
	return isDevelopment
		? path.resolve(__dirname, '../../target/debug/sprocket')
		: path.join(__dirname, 'server/sprocket');
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

async function startLocalServer() {
	if (serverBaseUrl) {
		return serverBaseUrl;
	}

	const port = serverPort;
	const host = serverHost;
	const dataDir = getLocalDataDir();
	const serverBinary = getServerBinaryPath();
	const staticDir = isDevelopment ? undefined : path.join(__dirname, 'web/dist');
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

	serverProcess = spawn(serverBinary, args, {
		env: {
			...process.env,
			SPROCKET_HOST: host,
			SPROCKET_PORT: String(port),
			SPROCKET_DATA_DIR: dataDir,
			SPROCKET_DESKTOP_BOOTSTRAP_TOKEN: desktopBootstrapToken,
			...(staticDir ? { SPROCKET_STATIC_DIR: staticDir } : {})
		},
		stdio: ['ignore', 'pipe', 'inherit']
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
			return;
		}

		if (code && code !== 0) {
			console.error(`Sprocket local server exited with code ${code}`);
		}
	});

	const fallbackBaseUrl = `http://${host}:${port}`;
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

	const bootstrap = await bootstrapResponse.json();
	serverPairingCredential = bootstrap.pairingCredential;
	serverBaseUrl = bootstrap.httpBaseUrl ?? serverBaseUrl;
	serverDesktopLoginCallbackUrl =
		typeof bootstrap.desktopLoginCallbackUrl === 'string' &&
		bootstrap.desktopLoginCallbackUrl.trim().length > 0
			? bootstrap.desktopLoginCallbackUrl.trim()
			: desktopLoginCallbackUrl;

	return serverBaseUrl;
}

function stopLocalServer() {
	if (!serverProcess || serverProcess.killed) {
		return;
	}

	serverProcess.kill();
	serverProcess = null;
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

	const targetUrl = isDevelopment ? devRendererUrl : `http://${serverHost}:${serverPort}`;

	void loadRendererWhenReady(mainWindow, targetUrl);
	if (isDevelopment) {
		mainWindow.webContents.openDevTools({ mode: 'detach' });
	}
}

ipcMain.handle('sprocket:get-local-bootstrap', () => {
	if (!serverBaseUrl || !serverPairingCredential) {
		throw new Error('Local server bootstrap is unavailable.');
	}

	return {
		httpBaseUrl: serverBaseUrl,
		desktopLoginCallbackUrl: serverDesktopLoginCallbackUrl ?? desktopLoginCallbackUrl,
		pairingCredential: serverPairingCredential
	};
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
	if (typeof url !== 'string' || url.trim().length === 0) {
		throw new Error('A URL is required.');
	}

	let parsed;
	try {
		parsed = new URL(url);
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
	if (process.platform === 'linux') {
		await openWithXdgOpen(parsedUrl);
		return;
	}

	await shell.openExternal(parsedUrl);
}

ipcMain.handle('sprocket:open-external', async (_event, url) => {
	await openExternalHttpsUrl(url);
});

ipcMain.handle('sprocket:focus-window', () => {
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

app.whenReady().then(async () => {
	Menu.setApplicationMenu(null);

	try {
		await startLocalServer();
	} catch (error) {
		console.error('Failed to start Sprocket local server', error);
		app.quit();
		return;
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

app.on('before-quit', () => {
	stopLocalServer();
});
