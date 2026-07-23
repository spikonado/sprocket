import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureExecutable, nativePackage, run } from '../lib/launcher.js';

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

test('runs the native executable with unchanged arguments and environment', () => {
	const expectedEnv = { SPROCKET_STATIC_DIR: '/tmp/web' };
	let invocation;
	const status = run('/tmp/sprocket', ['--web', './robot'], {
		env: expectedEnv,
		spawn(binary, args, options) {
			invocation = { binary, args, options };
			return { status: 0 };
		}
	});

	assert.deepEqual(invocation, {
		binary: '/tmp/sprocket',
		args: ['--web', './robot'],
		options: { stdio: 'inherit', env: expectedEnv }
	});
	assert.equal(status, 0);
});
