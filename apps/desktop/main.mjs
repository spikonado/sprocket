import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDevelopment = !app.isPackaged;
const rendererUrl = process.env.SPROCKET_ELECTRON_RENDERER_URL ?? 'http://localhost:5173';
const preloadEntry = path.join(__dirname, 'preload.mjs');

// Register custom protocol for production
// This must be called before app.ready
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

function loadNativeModule() {
	return require('@sprocket/native');
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

	if (isDevelopment) {
		void mainWindow.loadURL(rendererUrl);
		mainWindow.webContents.openDevTools({ mode: 'detach' });
		return;
	}

	// Load the root URL, not /index.html, to prevent SvelteKit routing 404s
	void mainWindow.loadURL('sprocket://app/');
}

ipcMain.handle('native:get-runtime-info', async () => {
	const native = loadNativeModule();

	return native.getRuntimeInfo();
});

app.whenReady().then(() => {
	if (!isDevelopment) {
		const webDistDir = path.join(__dirname, 'web/dist');

		protocol.handle('sprocket', (request) => {
			const url = new URL(request.url);
			if (url.hostname !== 'app') {
				return new Response('Not Found', { status: 404 });
			}

			// Map root and empty paths to index.html
			let pathname = url.pathname;
			if (pathname === '/' || pathname === '') {
				pathname = '/index.html';
			}

			const filePath = path.join(webDistDir, pathname);

			// SPA fallback: if file doesn't exist, serve index.html
			// net.fetch handles ASAR paths and MIME types automatically
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
