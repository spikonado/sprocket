import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureExecutable, launch, nativePackage } from '../lib/launcher.js';

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
			return { status: 0 };
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
				return { status: 0 };
			}
		});
		assert.equal(code, 0);
		assert.deepEqual(invocation, { binary: '/tmp/sprocket', args });
	}
});
