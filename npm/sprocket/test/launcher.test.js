import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureExecutable, launch, nativePackage, run } from '../lib/launcher.js';

function successfulChild() {
	const child = new EventEmitter();
	queueMicrotask(() => child.emit('close', 0, null));

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
				const launcher = spawn(
					process.execPath,
					[path.join(import.meta.dirname, 'launcher-shutdown-helper.mjs')],
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
				assert.match(output, /SHUTDOWN_COMPLETED/);
				assert.equal(code, null);
				assert.equal(exitSignal, signal);
				await closed;
			}
		);
	}
}
