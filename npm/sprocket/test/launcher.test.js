import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureExecutable, launch, RESTART_EXIT_CODE, run } from '../lib/launcher.js';
import { nativePackage } from '../lib/native.js';

function successfulChild(code = 0) {
	const child = new EventEmitter();
	queueMicrotask(() => child.emit('close', code, null));

	return child;
}

test('selects the native package for supported platforms', () => {
	assert.deepEqual(nativePackage('linux', 'x64'), [
		'@spikonado/sprocket-linux-x64-gnu',
		'sprocket'
	]);
	assert.deepEqual(nativePackage('win32', 'x64'), [
		'@spikonado/sprocket-win32-x64-msvc',
		'sprocket.exe'
	]);
	assert.equal(nativePackage('freebsd', 'x64'), undefined);
});

test('restores execute bits on unix binaries', { skip: process.platform === 'win32' }, () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'sprocket-chmod-'));
	const binary = path.join(directory, 'sprocket');

	try {
		writeFileSync(binary, '#!/bin/sh\n');
		chmodSync(binary, 0o644);
		ensureExecutable(binary);
		assert.equal(statSync(binary).mode & 0o111, 0o111);

		chmodSync(binary, 0o555);
		ensureExecutable(binary);
		assert.equal(statSync(binary).mode & 0o111, 0o111);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('overrides inherited update helper environment for the native child', async () => {
	let invocation;
	await launch(['--web'], {
		env: {
			SPROCKET_STATIC_DIR: '/tmp/web',
			SPROCKET_UPDATE_NODE: '/evil/node',
			SPROCKET_UPDATE_SCRIPT: '/evil/update-api.js',
			SPROCKET_UPDATE_MANAGED: '1'
		},
		execPath: '/usr/bin/node',
		libDir: '/pkg/lib',
		resolveBinary: () => '/tmp/sprocket',
		ensureExecutable: () => {},
		spawn(binary, args, options) {
			invocation = { binary, args, options };

			return successfulChild();
		}
	});
	assert.equal(invocation.options.env.SPROCKET_UPDATE_NODE, '/usr/bin/node');
	assert.equal(
		invocation.options.env.SPROCKET_UPDATE_SCRIPT,
		path.resolve('/pkg/lib', 'update-api.js')
	);
	assert.equal(invocation.options.env.SPROCKET_STATIC_DIR, '/tmp/web');
	assert.equal(Object.hasOwn(invocation.options.env, 'SPROCKET_UPDATE_MANAGED'), false);
});

test('starts the updated launcher after the native server exits to restart', async (t) => {
	const directory = mkdtempSync(path.join(tmpdir(), 'sprocket-restart-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const updatedLauncher = '/opt/sprocket/bin/sprocket.js';
	const invocations = [];

	const code = await launch(['--web'], {
		env: {},
		execPath: '/usr/bin/node',
		tmpdir: directory,
		resolveBinary: () => '/tmp/sprocket',
		ensureExecutable: () => {},
		spawn(binary, args, options) {
			invocations.push({ binary, args, env: options.env });

			if (invocations.length === 1) {
				writeFileSync(options.env.SPROCKET_RESTART_FILE, updatedLauncher);

				return successfulChild(RESTART_EXIT_CODE);
			}

			return successfulChild();
		}
	});

	assert.equal(code, 0);
	const [native, restarted] = invocations;
	assert.equal(native.binary, '/tmp/sprocket');
	assert.equal(path.dirname(native.env.SPROCKET_RESTART_FILE), directory);
	assert.equal(restarted.binary, '/usr/bin/node');
	assert.deepEqual(restarted.args, [updatedLauncher, '--web']);
	assert.equal(restarted.env.SPROCKET_RESTART_FILE, native.env.SPROCKET_RESTART_FILE);
	assert.equal(restarted.env.SPROCKET_RESTARTED, '1');
	assert.equal(existsSync(native.env.SPROCKET_RESTART_FILE), false);
});

test('a restarted launcher passes the next restart up to its parent', async () => {
	const invocations = [];

	const code = await launch(['--web'], {
		env: {
			SPROCKET_RESTART_FILE: '/tmp/sprocket-restart-parent',
			SPROCKET_RESTARTED: '1'
		},
		resolveBinary: () => '/tmp/sprocket',
		ensureExecutable: () => {},
		spawn(binary, args, options) {
			invocations.push(options.env);

			return successfulChild(RESTART_EXIT_CODE);
		}
	});

	assert.equal(code, RESTART_EXIT_CODE);
	assert.equal(invocations.length, 1);
	assert.equal(invocations[0].SPROCKET_RESTART_FILE, '/tmp/sprocket-restart-parent');
	assert.equal(invocations[0].SPROCKET_RESTARTED, '1');
});

test('update and upgrade help is delegated to the native CLI', async () => {
	for (const args of [
		['update', '--help'],
		['upgrade', '-h']
	]) {
		let invocation;

		const code = await launch(args, {
			resolveBinary: () => '/tmp/sprocket',
			ensureExecutable: () => {},
			spawn(binary, childArgs) {
				invocation = { binary, args: childArgs };

				return successfulChild();
			}
		});

		assert.equal(code, 0);
		assert.deepEqual(invocation, { binary: '/tmp/sprocket', args });
	}
});

test('returns the native child exit code and removes signal handlers', async () => {
	const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
	assert.equal(await run(process.execPath, ['-e', 'process.exit(7)']), 7);
	assert.deepEqual(
		['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
		listeners
	);
});

test('reports a failed native launch and removes signal handlers', async () => {
	const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
	await assert.rejects(run(path.join(tmpdir(), 'sprocket-missing', 'binary'), []), {
		code: 'ENOENT'
	});
	assert.deepEqual(
		['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
		listeners
	);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	for (const target of ['launcher', 'process group']) {
		test(
			`waits for native shutdown when ${signal} is sent to the ${target}`,
			{ skip: process.platform === 'win32', timeout: 10_000 },
			async (t) => {
				const directory = mkdtempSync(path.join(tmpdir(), 'sprocket-shutdown-'));
				const completed = path.join(directory, 'completed');
				t.after(() => rmSync(directory, { recursive: true, force: true }));

				const launcher = spawn(
					process.execPath,
					[path.join(import.meta.dirname, 'launcher-shutdown-helper.mjs'), completed],
					{ detached: true, stdio: ['ignore', 'pipe', 'inherit'] }
				);

				t.after(() => {
					try {
						process.kill(-launcher.pid, 'SIGKILL');
					} catch (error) {
						assert.equal(error.code, 'ESRCH');
					}
				});

				let output = '';
				launcher.stdout.setEncoding('utf8');

				const ready = new Promise((resolve) => {
					launcher.stdout.on('data', (data) => {
						output += data;

						if (output.includes('READY')) {
							resolve();
						}
					});
				});

				const exited = once(launcher, 'exit');
				const closed = once(launcher, 'close');

				await Promise.race([
					ready,
					exited.then(() => assert.fail('launcher exited before startup'))
				]);
				process.kill(target === 'launcher' ? launcher.pid : -launcher.pid, signal);
				const [code, exitSignal] = await exited;
				assert.ok(existsSync(completed), 'native shutdown must complete before the launcher exits');
				await closed;
				assert.match(output, /SHUTDOWN_COMPLETED/);
				assert.equal(code, null);
				assert.equal(exitSignal, signal);
			}
		);
	}
}
