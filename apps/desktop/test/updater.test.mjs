import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DesktopUpdater, stopUpdateProcess } from '../updater.mjs';

class FakeUpdater extends EventEmitter {
	checks = 0;
	downloads = 0;
	installs = 0;
	checkForUpdates = async () => {
		this.checks += 1;
		this.emit('update-available', { version: '1.1.0' });
	};
	downloadUpdate = async () => {
		this.downloads += 1;
		this.emit('download-progress', { percent: 51.2 });
		this.emit('update-downloaded', { version: '1.1.0' });
	};
	quitAndInstall(silent, relaunch) {
		assert.equal(silent, false);
		assert.equal(relaunch, undefined);
		this.installs += 1;
	}
}

test('checking never downloads or installs without an explicit action', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '1.0.0', true);
	assert.equal(native.autoDownload, false);
	assert.equal(native.autoInstallOnAppQuit, false);
	assert.equal(native.autoRunAppAfterInstall, true);
	assert.equal(native.allowDowngrade, false);
	assert.equal(native.disableWebInstaller, true);
	assert.equal(native.allowPrerelease, false);
	assert.equal(updates.install(), false);
	await updates.download();
	assert.equal(native.downloads, 0);
	await updates.check();
	assert.equal(updates.getState().status, 'available');
	assert.equal(native.downloads, 0);
	assert.equal(native.installs, 0);
	await updates.download();
	assert.equal(updates.getState().status, 'downloaded');
	assert.equal(native.installs, 0);
	await updates.check();
	assert.equal(native.checks, 1);
	assert.equal(updates.install(), true);
	assert.equal(updates.install(), false);
	assert.equal(native.installs, 1);
});

test('development and unpacked Linux builds cannot update', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '0.0.0', false);
	await updates.check();
	await updates.download();
	assert.equal(updates.install(), false);
	assert.equal(updates.getState().status, 'unavailable');
	assert.equal(native.checks, 0);
});

test('concurrent clicks share a download and do not overwrite its state', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '1.0.0', true);
	let finish;
	native.downloadUpdate = () => {
		native.downloads += 1;
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	await updates.check();
	const first = updates.download();
	await updates.download();
	await updates.check();
	assert.equal(updates.getState().status, 'downloading');
	assert.equal(native.downloads, 1);
	assert.equal(updates.install(), false);
	native.emit('update-downloaded', { version: '1.1.0' });
	finish();
	await first;
	assert.equal(updates.getState().status, 'downloaded');
});

test('download errors preserve the version and can be retried', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '1.0.0', true);
	await updates.check();
	const download = native.downloadUpdate;
	native.downloadUpdate = async () => {
		throw new Error('Connection lost');
	};
	await updates.download();
	assert.equal(updates.getState().error, 'Connection lost');
	assert.equal(updates.getState().version, '1.1.0');
	native.downloadUpdate = download;
	await updates.download();
	assert.equal(updates.getState().status, 'downloaded');
	assert.equal(updates.getState().error, null);
});

test('failed background checks retry and subscribers can unsubscribe', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '1.0.0-canary.1', true);
	assert.equal(native.allowPrerelease, true);
	const check = native.checkForUpdates;
	const states = [];
	const unsubscribe = updates.subscribe((state) => states.push(state.status));
	native.checkForUpdates = async () => {
		throw new Error('Offline');
	};
	await updates.check();
	assert.equal(updates.getState().status, 'error');
	assert.equal(updates.getState().version, null);
	assert.deepEqual(states, ['checking', 'error']);
	unsubscribe();
	native.checkForUpdates = check;
	await updates.check();
	assert.equal(updates.getState().status, 'available');
	assert.deepEqual(states, ['checking', 'error']);
});

test('an installer error emitted synchronously does not report a successful restart', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '1.0.0', true);
	await updates.check();
	await updates.download();
	native.quitAndInstall = () => native.emit('error', new Error('Installer could not start'));
	assert.equal(updates.install(), false);
	assert.equal(updates.getState().status, 'downloaded');
});

test('asynchronous Squirrel failures leave a retryable update', async () => {
	const native = new FakeUpdater();
	const updates = new DesktopUpdater(native, '1.0.0', true);
	await updates.check();
	await updates.download();
	updates.install();
	native.emit('error', new Error('Code signature invalid'));
	assert.equal(updates.getState().status, 'downloaded');
	assert.equal(updates.getState().version, '1.1.0');
	assert.equal(updates.install(), true);
	assert.equal(native.downloads, 1);
});

test('owned server shutdown is bounded even with long-lived connections', async () => {
	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	const signals = [];
	child.kill = (signal) => {
		signals.push(signal);
		if (signal === 'SIGKILL') child.emit('exit', null, signal);
	};
	await stopUpdateProcess(child, 1, 100);
	assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
	assert.equal(child.listenerCount('exit'), 0);
	assert.equal(child.listenerCount('error'), 0);
});

test('a graceful server exit is not force-killed', async () => {
	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	const signals = [];
	child.kill = (signal) => {
		signals.push(signal);
		child.emit('exit', 0, null);
	};
	await stopUpdateProcess(child, 1, 100);
	assert.deepEqual(signals, ['SIGTERM']);
});
