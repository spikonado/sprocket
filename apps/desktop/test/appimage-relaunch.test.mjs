import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createAppImageUpdater } from '../updater.mjs';

const exec = promisify(execFile);
const skipOnWindows = { skip: process.platform === 'win32' };
const testFile = fileURLToPath(import.meta.url);
const relaunchArgs = ['renamed AppImage', '$(exit 47)', '"; exit 48; #'];
const rolePrefix = '--sprocket-appimage-role=';
const originalPidPrefix = '--sprocket-original-pid=';

function createTestUpdater(spawnLog) {
	return createAppImageUpdater(
		class {
			spawnLog(...args) {
				return spawnLog(...args);
			}
		}
	);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === 'ESRCH') return false;
		throw error;
	}
}

function waitUntil(predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
}

function flagValue(prefix) {
	const arg = process.argv.find((value) => value.startsWith(prefix));
	return arg?.slice(prefix.length) ?? null;
}

function execEnv() {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_CHANNEL_FD;
	return env;
}

const role = flagValue(rolePrefix);

if (role === 'original-app') {
	const updater = createTestUpdater((command, args) => {
		const child = spawn(command, args, { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
		child.unref();
	});
	updater.spawnLog(process.execPath, [
		testFile,
		`${rolePrefix}replacement`,
		`${originalPidPrefix}${process.pid}`
	]);
	process.exit(0);
}

if (role === 'replacement') {
	const originalParent = Number(flagValue(originalPidPrefix));
	const parentAtStart = process.ppid;
	waitUntil(() => !isAlive(originalParent), 4000, 'original app did not exit');
	process.kill(parentAtStart, 0);
	console.log(
		JSON.stringify({
			originalAlive: isAlive(originalParent),
			originalParent,
			parent: process.ppid,
			parentAtStart
		})
	);
	process.exit(0);
}

test('AppImage relaunch passes paths and arguments literally', skipOnWindows, async () => {
	const updater = createTestUpdater((command, args, env) =>
		exec(command, args, { env, timeout: 5000 })
	);
	const result = await updater.spawnLog(
		process.execPath,
		['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...relaunchArgs],
		process.env
	);
	assert.deepEqual(JSON.parse(result.stdout), relaunchArgs);
});

test(
	'AppImage launcher retains a living parent after the old app exits',
	skipOnWindows,
	async () => {
		const { stdout, stderr } = await exec(
			process.execPath,
			[testFile, `${rolePrefix}original-app`],
			{
				timeout: 5000,
				env: execEnv()
			}
		);
		assert.ok(stdout, stderr || 'replacement produced no output');
		const result = JSON.parse(stdout);
		assert.equal(result.originalAlive, false);
		assert.equal(result.parent, result.parentAtStart);
		assert.notEqual(result.parent, result.originalParent);
		assert.ok(result.parent > 1);
	}
);
