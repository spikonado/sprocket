export function createAppImageUpdater(AppImageUpdater) {
	return new (class extends AppImageUpdater {
		spawnLog(command, args = [], env, stdio) {
			// appimage-run uses bwrap --die-with-parent. Keep its parent alive after Electron exits.
			return super.spawnLog(
				'/bin/sh',
				['-c', '"$@" <&0 & child=$!; wait "$child"', 'sprocket-update-relaunch', command, ...args],
				env,
				stdio
			);
		}
	})();
}

export class DesktopUpdater {
	#updater;
	#state;
	#listeners = new Set();
	#operation = null;
	#enabled;

	constructor(updater, currentVersion, enabled) {
		this.#updater = updater;
		this.#enabled = enabled;
		this.#state = {
			method: 'desktop',
			status: enabled ? 'idle' : 'unavailable',
			currentVersion,
			version: null,
			progress: null,
			error: null
		};
		updater.autoDownload = false;
		updater.autoInstallOnAppQuit = false;
		updater.autoRunAppAfterInstall = true;
		updater.allowDowngrade = false;
		updater.disableWebInstaller = true;
		updater.allowPrerelease = currentVersion.includes('-canary.');
		updater.on('update-available', (info) => {
			this.#setState({ status: 'available', version: info.version, error: null });
		});
		updater.on('update-not-available', () => {
			this.#setState({ status: 'idle', version: null, error: null });
		});
		updater.on('download-progress', (progress) => {
			this.#setState({ progress: Math.max(0, Math.min(100, Math.round(progress.percent))) });
		});
		updater.on('update-downloaded', (info) => {
			this.#setState({ status: 'downloaded', version: info.version, progress: 100, error: null });
		});
		updater.on('error', (error) => this.#fail(error));
	}

	getState() {
		return { ...this.#state };
	}

	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#setState(change) {
		this.#state = { ...this.#state, ...change };
		for (const listener of this.#listeners) listener(this.getState());
	}

	#fail(error) {
		const installing = this.#state.status === 'installing';
		this.#setState({
			status: installing ? 'downloaded' : 'error',
			error: error instanceof Error ? error.message : String(error),
			progress: installing ? 100 : null
		});
	}

	async #run(status, operation) {
		this.#setState({ status, error: null, progress: null });
		this.#operation = Promise.resolve().then(operation);
		try {
			await this.#operation;
		} catch (error) {
			this.#fail(error);
		} finally {
			this.#operation = null;
		}
		return this.getState();
	}

	async check() {
		if (
			!this.#enabled ||
			this.#operation ||
			['available', 'downloaded', 'installing'].includes(this.#state.status) ||
			this.#state.version
		) {
			return this.getState();
		}
		return this.#run('checking', () => this.#updater.checkForUpdates());
	}

	async download() {
		if (
			!this.#enabled ||
			this.#operation ||
			!this.#state.version ||
			!['available', 'error'].includes(this.#state.status)
		) {
			return this.getState();
		}
		return this.#run('downloading', () => this.#updater.downloadUpdate());
	}

	install() {
		if (this.#state.status !== 'downloaded' || this.#operation) return false;
		this.#setState({ status: 'installing', error: null });
		try {
			this.#updater.quitAndInstall(false);
			return this.#state.status === 'installing';
		} catch (error) {
			this.#fail(error);
			return false;
		}
	}
}

export function stopUpdateProcess(child, graceMs = 5_000, killWaitMs = 5_000) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let timer;
		const finish = (error) => {
			clearTimeout(timer);
			child.removeListener('exit', onExit);
			child.removeListener('error', finish);
			if (error) reject(error);
			else resolve();
		};
		const onExit = () => finish();
		child.once('exit', onExit);
		child.once('error', finish);
		timer = setTimeout(() => {
			timer = setTimeout(() => finish(new Error('The local server did not stop.')), killWaitMs);
			try {
				child.kill('SIGKILL');
			} catch (error) {
				finish(error);
			}
		}, graceMs);
		try {
			child.kill('SIGTERM');
		} catch (error) {
			finish(error);
		}
	});
}
