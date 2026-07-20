import assert from 'node:assert/strict';
import test from 'node:test';

import { nativePackage, run } from '../lib/launcher.js';

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
