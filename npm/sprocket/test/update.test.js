import assert from 'node:assert/strict';
import { mkdtempSync, promises as fsPromises, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
	PACKAGE_NAME,
	RELAUNCH_MESSAGE,
	UNSUPPORTED_MESSAGE,
	channelManifestUrl,
	channelUpdate,
	checkForUpdate,
	compareReleaseVersions,
	createHost,
	createRunCommand,
	detectInstall,
	globalPackageDir,
	installUpdate,
	isAllowedVersion,
	isWindowsBusyExecutable,
	killProcessTree,
	makePayload,
	parseUpdateArgs,
	registryUrl,
	releaseChannel,
	runUpdateApi,
	runUpdateCli,
	taskkillPath,
	timeoutRecoveryMessage,
	updateLockPath
} from '../lib/update.js';

const DEV_SHA = '0123456789abcdef0123456789abcdef01234567';
const DEV_SHA_HIGH = 'f'.repeat(40);
const DEV_SHA_LOW = '0'.repeat(40);
const NPM_CLI = '/usr/bin/node_modules/npm/bin/npm-cli.js';
const NPM_ROOT = '/usr/local/lib/node_modules';
const NPM_PACKAGE = `${NPM_ROOT}/@spikonado/sprocket`;

function jsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return body;
		}
	};
}

function versionDoc(version) {
	return { name: PACKAGE_NAME, version };
}

function managerOf(command, args) {
	if (args.some((arg) => /npm-cli\.js$/i.test(arg)) || /(?:^|[/\\])npm(?:\.cmd)?$/i.test(command)) {
		return 'npm';
	}
	if (
		args.some((arg) => /pnpm\.cjs$/i.test(arg)) ||
		/(?:^|[/\\])pnpm(?:\.cmd|\.exe)?$/i.test(command)
	) {
		return 'pnpm';
	}
	if (
		args.some((arg) => /yarn\.js$/i.test(arg)) ||
		/(?:^|[/\\])yarn(?:\.cmd|\.exe)?$/i.test(command)
	) {
		return 'yarn';
	}
	if (/(?:^|[/\\])bun(?:\.exe)?$/i.test(command) || args.includes('pm')) {
		return 'bun';
	}
	return 'unknown';
}

function isInstallArgs(args) {
	return (
		(args.includes('install') && args.includes('--global')) ||
		(args.includes('add') && args.includes('--global')) ||
		(args.includes('global') && args.includes('add'))
	);
}

async function waitForFile(file) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			readFileSync(file);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`missing ${file}`);
}

async function waitForProcessToStop(pid) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
			if (process.platform === 'linux') {
				const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
				// A killed orphan may still have a PID until the runner's init reaps it.
				if (['Z', 'X'].includes(stat[stat.lastIndexOf(')') + 2])) {
					return;
				}
			}
		} catch (error) {
			if (error.code === 'ESRCH' || error.code === 'ENOENT') return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`process ${pid} is still running`);
}

function testHost(options = {}) {
	const commands = [];
	const fetched = [];
	const lockFiles = options.lockFiles ?? new Map();
	let releaseInstall;
	const installHold = options.holdInstall
		? new Promise((resolve) => {
				releaseInstall = resolve;
			})
		: null;

	const host = createHost({
		platform: options.platform ?? 'linux',
		execPath: options.execPath ?? '/usr/bin/node',
		packageRoot: options.packageRoot ?? NPM_PACKAGE,
		currentVersion: options.currentVersion ?? '0.3.4',
		pid: options.pid ?? 1001,
		env: options.env ?? { PATH: '/usr/bin' },
		tmpdir: options.tmpdir ?? (() => '/tmp'),
		homedir: options.homedir ?? (() => '/home/user'),
		isFile: options.isFile ?? ((file) => file === NPM_CLI || Boolean(options.files?.[file])),
		findExecutable: options.findExecutable ?? ((name) => options.executables?.[name]),
		realpath: options.realpath ?? ((file) => file),
		fetch:
			options.fetch ??
			(async (url) => {
				fetched.push(String(url));
				return jsonResponse(options.manifest ?? versionDoc('0.3.5'));
			}),
		runCommand: async (command, args, spawnOptions) => {
			commands.push({ command, args, options: spawnOptions });
			if (options.runCommand) {
				return options.runCommand(command, args, spawnOptions);
			}
			if (args.includes('pm') && args.includes('bin')) {
				return options.bunBin
					? { status: 0, stdout: options.bunBin, stderr: '' }
					: { status: 1, stdout: '', stderr: 'not bun' };
			}
			if (args.includes('global') && args.includes('dir') && !args.includes('add')) {
				return options.yarnDir
					? { status: 0, stdout: options.yarnDir, stderr: '' }
					: { status: 1, stdout: '', stderr: 'not yarn' };
			}
			if (args.includes('root') && args.includes('-g')) {
				const manager = managerOf(command, args);
				const stdout = manager === 'pnpm' ? options.pnpmRoot : (options.npmRoot ?? NPM_ROOT);
				return stdout
					? { status: 0, stdout, stderr: '' }
					: { status: 1, stdout: '', stderr: 'no root' };
			}
			if (isInstallArgs(args)) {
				if (installHold) {
					await installHold;
				}
				return options.install ?? { status: 0, stdout: '', stderr: '' };
			}
			return { status: 1, stdout: '', stderr: 'unexpected command' };
		},
		open:
			options.open ??
			(async (file, flags) => {
				if (flags === 'wx' && lockFiles.has(file)) {
					const error = new Error('EEXIST');
					error.code = 'EEXIST';
					throw error;
				}
				lockFiles.set(file, '');
				return {
					writeFile: async (contents) => {
						lockFiles.set(file, String(contents));
					},
					close: async () => {}
				};
			}),
		unlink:
			options.unlink ??
			(async (file) => {
				lockFiles.delete(file);
			}),
		readFile:
			options.readFile ??
			((file) => {
				if (lockFiles.has(file)) {
					return lockFiles.get(file);
				}
				const error = new Error('ENOENT');
				error.code = 'ENOENT';
				throw error;
			}),
		writeStdout: options.writeStdout ?? (() => {}),
		writeStderr: options.writeStderr ?? (() => {})
	});

	return { host, commands, fetched, lockFiles, releaseInstall };
}

test('maps installed versions onto latest, canary, and dev channels', () => {
	assert.equal(releaseChannel('0.3.4'), 'latest');
	assert.equal(releaseChannel('0.3.4-canary.1'), 'canary');
	assert.equal(releaseChannel(`0.3.4-dev.${DEV_SHA}`), 'dev');
});

test('accepts only registry versions that match the release channel', () => {
	assert.equal(isAllowedVersion('0.3.5', 'latest'), true);
	assert.equal(isAllowedVersion('0.3.5-canary.1', 'latest'), false);
	assert.equal(isAllowedVersion('0.3.5; rm -rf /', 'latest'), false);
	assert.equal(isAllowedVersion('--prefix=/tmp', 'latest'), false);
	assert.equal(isAllowedVersion('0.3.5-canary.1', 'canary'), true);
	assert.equal(isAllowedVersion(`0.3.5-dev.${DEV_SHA}`, 'dev'), true);
	assert.equal(isAllowedVersion('0.3.5-dev.abc', 'dev'), false);
});

test('stable and canary updates move forward only', () => {
	assert.equal(compareReleaseVersions('0.3.5', '0.3.4') > 0, true);
	assert.equal(compareReleaseVersions('0.3.4', '0.4.0') > 0, false);
	assert.equal(compareReleaseVersions('0.3.4-canary.10', '0.3.4-canary.2') > 0, true);
	assert.equal(channelUpdate('0.4.0', '0.3.5').status, 'idle');
	assert.equal(channelUpdate('0.3.4-canary.10', '0.3.4-canary.2').status, 'idle');
	assert.equal(channelUpdate('0.3.4', '0.3.5').status, 'available');
});

test('dev updates follow a changed commit hash without ordering the hash', () => {
	const current = `0.3.5-dev.${DEV_SHA_HIGH}`;
	const tagged = `0.3.4-dev.${DEV_SHA_LOW}`;
	assert.equal(channelUpdate(current, tagged).status, 'available');
	assert.equal(channelUpdate(current, current).status, 'idle');
});

test('parses update, upgrade, --check, and help', () => {
	assert.deepEqual(parseUpdateArgs(['serve']), { kind: 'none' });
	assert.deepEqual(parseUpdateArgs(['update']), { kind: 'run', check: false });
	assert.deepEqual(parseUpdateArgs(['upgrade', '--check']), { kind: 'run', check: true });
	assert.equal(parseUpdateArgs(['update', '--help']).kind, 'native');
	assert.equal(parseUpdateArgs(['update', '--force']).kind, 'invalid');
});

test('detects a global npm install from the exact package path', async () => {
	const { host } = testHost();
	const install = await detectInstall(host);
	assert.equal(install.supported, true);
	assert.equal(install.manager, 'npm');
});

test('does not treat a nested global dependency as this install', async () => {
	const { host, commands } = testHost({
		packageRoot: `${NPM_ROOT}/other-tool/node_modules/@spikonado/sprocket`
	});
	const install = await detectInstall(host);
	assert.equal(install.supported, false);
	assert.equal(
		commands.some((command) => isInstallArgs(command.args)),
		false
	);
});

test('does not treat a local or npx copy as updatable just because npm is on PATH', async () => {
	for (const packageRoot of [
		'/home/user/app/node_modules/@spikonado/sprocket',
		'/home/user/.npm/_npx/a1b2/node_modules/@spikonado/sprocket'
	]) {
		const { host, commands } = testHost({
			packageRoot,
			executables: { npm: '/usr/bin/npm' },
			isFile: () => false,
			npmRoot: NPM_ROOT
		});
		const install = await detectInstall(host);
		assert.equal(install.supported, false, packageRoot);
		assert.equal(
			commands.some((command) => isInstallArgs(command.args)),
			false
		);
	}
});

test('detects global bun, pnpm, and yarn installs from their own prefix queries', async () => {
	const bun = await detectInstall(
		testHost({
			execPath: '/home/user/.bun/bin/bun',
			packageRoot: '/home/user/.bun/install/global/node_modules/@spikonado/sprocket',
			bunBin: '/home/user/.bun/bin',
			isFile: () => false
		}).host
	);
	assert.equal(bun.supported, true);
	assert.equal(bun.manager, 'bun');

	const physical =
		'/home/user/.local/share/pnpm/global/5/node_modules/.pnpm/@spikonado+sprocket@0.3.4/node_modules/@spikonado/sprocket';
	const logical = '/home/user/.local/share/pnpm/global/5/node_modules/@spikonado/sprocket';
	const pnpm = await detectInstall(
		testHost({
			packageRoot: physical,
			executables: { pnpm: '/usr/bin/pnpm' },
			pnpmRoot: '/home/user/.local/share/pnpm/global/5/node_modules',
			isFile: () => false,
			realpath: (file) => (file === logical ? physical : file)
		}).host
	);
	assert.equal(pnpm.supported, true);
	assert.equal(pnpm.manager, 'pnpm');

	const yarn = await detectInstall(
		testHost({
			packageRoot: '/home/user/.config/yarn/global/node_modules/@spikonado/sprocket',
			executables: { yarn: '/usr/bin/yarn' },
			yarnDir: '/home/user/.config/yarn/global',
			isFile: () => false
		}).host
	);
	assert.equal(yarn.supported, true);
	assert.equal(yarn.manager, 'yarn');
});

test('does not install with bun just because bun is on PATH for an npm global', async () => {
	const { host, commands } = testHost({
		executables: { bun: '/usr/bin/bun' },
		bunBin: '/home/user/.bun/bin'
	});
	const payload = await installUpdate(host);
	assert.equal(payload.status, 'installed');
	const install = commands.find((command) => isInstallArgs(command.args));
	assert.equal(install.command, '/usr/bin/node');
	assert.ok(install.args.includes(NPM_CLI));
	assert.ok(install.args.includes(`${PACKAGE_NAME}@0.3.5`));
	assert.ok(!install.args.includes(`${PACKAGE_NAME}@latest`));
});

test('check reports unavailable, idle, and available without installing', async () => {
	const unavailable = await checkForUpdate(
		testHost({
			packageRoot: '/tmp/project/node_modules/@spikonado/sprocket',
			isFile: () => false
		}).host
	);
	assert.equal(unavailable.status, 'unavailable');
	assert.equal(unavailable.method, 'package');
	assert.equal(unavailable.version, null);
	assert.equal(unavailable.error, null);
	assert.equal(unavailable.message, UNSUPPORTED_MESSAGE);

	const idle = await checkForUpdate(
		testHost({
			manifest: versionDoc('0.3.4')
		}).host
	);
	assert.equal(idle.status, 'idle');
	assert.equal(idle.version, null);

	const { host, commands, fetched } = testHost();
	const available = await checkForUpdate(host);
	assert.equal(available.status, 'available');
	assert.equal(available.version, '0.3.5');
	assert.equal(available.currentVersion, '0.3.4');
	assert.equal(
		commands.some((command) => isInstallArgs(command.args)),
		false
	);
	assert.match(fetched[0], /\/latest$/);
});

test('does not offer a stable or canary downgrade when the installed version is newer', async () => {
	const stable = await checkForUpdate(
		testHost({
			currentVersion: '0.4.0',
			manifest: versionDoc('0.3.5')
		}).host
	);
	assert.equal(stable.status, 'idle');

	const canary = await checkForUpdate(
		testHost({
			currentVersion: '0.3.4-canary.10',
			manifest: versionDoc('0.3.4-canary.2')
		}).host
	);
	assert.equal(canary.status, 'idle');
});

test('install re-checks and stays idle when the channel is already current', async () => {
	const { host, commands } = testHost({
		manifest: versionDoc('0.3.4')
	});
	const payload = await installUpdate(host);
	assert.equal(payload.status, 'idle');
	assert.equal(
		commands.some((command) => isInstallArgs(command.args)),
		false
	);
});

test('install returns installed with a relaunch message and keeps the running version', async () => {
	const payload = await installUpdate(testHost().host);
	assert.equal(payload.status, 'installed');
	assert.equal(payload.currentVersion, '0.3.4');
	assert.equal(payload.version, '0.3.5');
	assert.equal(payload.method, 'package');
	assert.equal(payload.message, RELAUNCH_MESSAGE);
	assert.equal(payload.error, null);
});

test('follows canary and dev dist-tags for those installs', async () => {
	const canaryVersion = '0.3.5-canary.9';
	const canary = await checkForUpdate(
		testHost({
			currentVersion: '0.3.4-canary.1',
			manifest: versionDoc(canaryVersion)
		}).host
	);
	assert.equal(canary.version, canaryVersion);

	const tagged = `0.3.4-dev.${DEV_SHA_LOW}`;
	const dev = await checkForUpdate(
		testHost({
			currentVersion: `0.3.5-dev.${DEV_SHA_HIGH}`,
			manifest: versionDoc(tagged)
		}).host
	);
	assert.equal(dev.status, 'available');
	assert.equal(dev.version, tagged);
});

test('rejects a channel manifest that is missing or malformed', async () => {
	const malformed = await runUpdateApi(
		'check',
		testHost({
			manifest: versionDoc('0.3.5;touch /tmp/pwned')
		}).host
	);
	assert.equal(malformed.exitCode, 1);
	assert.equal(malformed.payload.status, 'error');

	const missing = await runUpdateApi(
		'check',
		testHost({
			fetch: async () => jsonResponse({}, 404)
		}).host
	);
	assert.equal(missing.payload.status, 'error');
	assert.match(missing.payload.error, /HTTP 404/);
});

test('explains a Windows lock on the running native executable', async () => {
	assert.equal(
		isWindowsBusyExecutable('EBUSY unlink sprocket.exe resource busy or locked', 'win32'),
		true
	);
	const payload = await installUpdate(
		testHost({
			platform: 'win32',
			install: {
				status: 1,
				stdout: '',
				stderr: 'npm ERR! code EBUSY\nnpm ERR! syscall unlink\nnpm ERR! path C:\\npm\\sprocket.exe'
			}
		}).host
	);
	assert.equal(payload.status, 'error');
	assert.match(payload.error, /Windows cannot replace Sprocket while it is running/);
});

test('package manager commands never use a shell and detach on unix', async () => {
	let spawnOptions;
	const runCommand = createRunCommand((command, args, options) => {
		spawnOptions = options;
		return {
			stdout: { setEncoding() {}, on() {}, destroy() {} },
			stderr: { setEncoding() {}, on() {}, destroy() {} },
			on(event, handler) {
				if (event === 'close') {
					queueMicrotask(() => handler(0));
				}
			}
		};
	});
	await runCommand('/usr/bin/npm', ['install', '--global', `${PACKAGE_NAME}@0.3.5`], {
		cwd: '/home/user',
		platform: 'linux'
	});
	assert.equal(spawnOptions.shell, false);
	assert.equal(spawnOptions.detached, true);
	assert.equal(spawnOptions.timeout, undefined);
	assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
});

test('managed unix children stay in the helper process group', async () => {
	let spawnOptions;
	const selfKills = [];
	const runCommand = createRunCommand(
		(command, args, options) => {
			spawnOptions = options;
			return {
				pid: 99,
				stdout: { setEncoding() {}, on() {}, destroy() {} },
				stderr: { setEncoding() {}, on() {}, destroy() {} },
				on() {}
			};
		},
		async () => {},
		(pid) => {
			selfKills.push(pid);
		}
	);
	const result = await runCommand(
		'/usr/bin/npm',
		['install', '--global', `${PACKAGE_NAME}@0.3.5`],
		{
			env: { SPROCKET_UPDATE_MANAGED: '1' },
			platform: 'linux',
			timeout: 20,
			killWaitMs: 20
		}
	);
	assert.equal(spawnOptions.detached, false);
	assert.equal(result.timedOut, true);
	assert.deepEqual(selfKills, [-process.pid]);
});

test('command timeout kills the process tree and closes pipes', async () => {
	const killed = [];
	const stdout = {
		setEncoding() {},
		on() {},
		destroy() {
			this.destroyed = true;
		}
	};
	const stderr = {
		setEncoding() {},
		on() {},
		destroy() {
			this.destroyed = true;
		}
	};
	const child = {
		pid: 4321,
		stdout,
		stderr,
		on() {}
	};
	const runCommand = createRunCommand(
		() => child,
		(target, platform) => {
			killed.push({ pid: target.pid, platform });
		}
	);
	const result = await runCommand('npm', ['install', '--global', `${PACKAGE_NAME}@0.3.5`], {
		platform: 'linux',
		timeout: 20,
		killWaitMs: 20
	});
	assert.equal(result.timedOut, true);
	assert.deepEqual(killed, [{ pid: 4321, platform: 'linux' }]);
	assert.equal(stdout.destroyed, true);
	assert.equal(stderr.destroyed, true);
});

test('JSON helper returns exactly the documented payload shape', async () => {
	const { exitCode, payload } = await runUpdateApi('check', testHost().host);
	assert.equal(exitCode, 0);
	assert.deepEqual(Object.keys(payload).sort(), [
		'currentVersion',
		'error',
		'message',
		'method',
		'status',
		'version'
	]);
	assert.equal(payload.method, 'package');
	assert.equal(payload.status, 'available');

	const invalid = await runUpdateApi('download', testHost().host);
	assert.equal(invalid.exitCode, 1);
	assert.equal(invalid.payload.status, 'error');
});

test('upgrade --check is the same as update --check', async () => {
	let stdout = '';
	const host = testHost({
		writeStdout(text) {
			stdout += text;
		}
	}).host;
	const code = await runUpdateCli(parseUpdateArgs(['upgrade', '--check']), host);
	assert.equal(code, 0);
	assert.match(stdout, /0\.3\.5 is available/);
});

test('refuses to install when the lock cannot be created', async () => {
	const { host, commands } = testHost({
		open: async () => {
			const error = new Error('denied');
			error.code = 'EACCES';
			throw error;
		}
	});
	const payload = await installUpdate(host);
	assert.equal(payload.status, 'error');
	assert.match(payload.error, /Cannot write the update lock/);
	assert.equal(
		commands.some((command) => isInstallArgs(command.args)),
		false
	);
});

test('does not steal an existing lock even if its pid looks dead', async () => {
	const { host, lockFiles, commands } = testHost({ pid: 1001 });
	lockFiles.set(updateLockPath(host, NPM_ROOT), '9999');
	const payload = await installUpdate(host);
	assert.equal(payload.status, 'error');
	assert.match(payload.error, /already running/);
	assert.match(payload.error, /delete/);
	assert.equal(
		commands.some((command) => isInstallArgs(command.args)),
		false
	);
});

test('serializes concurrent installs with a lock outside the replaced package tree', async () => {
	const scratch = mkdtempSync(path.join(tmpdir(), 'sprocket-lock-'));
	try {
		const shared = {
			tmpdir: () => scratch,
			open: (file, flags) => fsPromises.open(file, flags),
			unlink: (file) => fsPromises.unlink(file),
			readFile: (file, encoding) => readFileSync(file, encoding)
		};
		const first = testHost({ ...shared, pid: 7001, holdInstall: true });
		const second = testHost({ ...shared, pid: 7002 }).host;
		const firstResultPromise = installUpdate(first.host);
		const lockPath = updateLockPath(first.host, NPM_ROOT);
		await waitForFile(lockPath);
		assert.equal(path.dirname(lockPath), scratch);
		const secondResult = await installUpdate(second);
		assert.equal(secondResult.status, 'error');
		assert.match(secondResult.error, /already running/);
		assert.match(secondResult.error, /delete/);
		first.releaseInstall();
		assert.equal((await firstResultPromise).status, 'installed');
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('lock identity follows the logical global package dir across pnpm versions', () => {
	const globalRoot = '/home/user/.local/share/pnpm/global/5/node_modules';
	const host = testHost({
		packageRoot: `${globalRoot}/.pnpm/@spikonado+sprocket@0.3.4/node_modules/@spikonado/sprocket`
	}).host;
	const later = testHost({
		packageRoot: `${globalRoot}/.pnpm/@spikonado+sprocket@0.3.5/node_modules/@spikonado/sprocket`
	}).host;
	assert.equal(globalPackageDir(globalRoot), path.join(globalRoot, '@spikonado', 'sprocket'));
	assert.equal(updateLockPath(host, globalRoot), updateLockPath(later, globalRoot));
	assert.notEqual(updateLockPath(host, globalRoot), updateLockPath(host, NPM_ROOT));
});

test('retains the update lock after a timed-out install', async () => {
	const { host, lockFiles } = testHost({
		install: { status: 1, timedOut: true, stdout: '', stderr: 'Timed out.' }
	});
	const lockPath = updateLockPath(host, NPM_ROOT);
	const payload = await installUpdate(host);
	assert.equal(payload.status, 'error');
	assert.equal(payload.error, timeoutRecoveryMessage(lockPath));
	assert.equal(lockFiles.has(lockPath), true);
});

test('windows killer uses System32 taskkill.exe, waits, and does not unref', async () => {
	const calls = [];
	let closeKiller;
	let closeChild;
	const killer = {
		unref() {
			calls.push('unref');
		},
		once(event, handler) {
			if (event === 'close') {
				closeKiller = () => {
					killer.exitCode = 0;
					handler(0);
				};
			}
		}
	};
	const child = {
		pid: 42,
		once(event, handler) {
			if (event === 'close') {
				closeChild = () => handler(1);
			}
		}
	};
	const pending = killProcessTree(child, 'win32', {
		env: { SystemRoot: 'C:\\Windows' },
		deadlineMs: 1000,
		spawn(command, args, options) {
			calls.push({ command, args, options });
			queueMicrotask(() => {
				closeKiller();
				closeChild();
			});
			return killer;
		}
	});
	await pending;
	assert.equal(calls[0].command, taskkillPath({ SystemRoot: 'C:\\Windows' }));
	assert.deepEqual(calls[0].args, ['/PID', '42', '/T', '/F']);
	assert.equal(calls[0].options.shell, false);
	assert.equal(calls.includes('unref'), false);
});

test('a child closing during timeout does not release the update before its killer finishes', async () => {
	const child = new EventEmitter();
	child.pid = 42;
	let releaseKiller;
	const killerFinished = new Promise((resolve) => {
		releaseKiller = resolve;
	});
	let notifyStarted;
	const killerStarted = new Promise((resolve) => {
		notifyStarted = resolve;
	});
	const runCommand = createRunCommand(
		() => child,
		async () => {
			child.exitCode = 1;
			child.emit('close', 1);
			notifyStarted();
			await killerFinished;
		}
	);
	let settled = false;
	const pending = runCommand('npm', [], { platform: 'win32', timeout: 1 }).then((result) => {
		settled = true;
		return result;
	});
	await killerStarted;
	assert.equal(settled, false);
	releaseKiller();
	assert.equal((await pending).timedOut, true);
});

test('a missing Windows taskkill reports failure without an unhandled error', async () => {
	const child = new EventEmitter();
	child.pid = 42;
	child.exitCode = 1;
	const killer = new EventEmitter();
	await assert.rejects(
		killProcessTree(child, 'win32', {
			env: { SystemRoot: 'C:\\Windows' },
			spawn() {
				queueMicrotask(() => killer.emit('error', new Error('taskkill missing')));
				return killer;
			}
		}),
		/taskkill missing/
	);
});

test(
	'managed helper timeout kills grandchild processes',
	{ skip: process.platform === 'win32' },
	async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'sprocket-managed-'));
		const pidFile = path.join(directory, 'grandchild.pid');
		try {
			const helper = spawn(
				process.execPath,
				[path.resolve(import.meta.dirname, 'managed-group-helper.mjs'), pidFile],
				{ detached: true, stdio: 'ignore' }
			);
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('helper did not exit')), 5000);
				helper.once('close', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			await waitForFile(pidFile);
			const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
			assert.equal(Number.isInteger(grandchildPid) && grandchildPid > 0, true);
			await waitForProcessToStop(grandchildPid);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
);

test('ignores relative PATH entries and relative npm_execpath', async () => {
	const files = new Set([
		'node_modules/.bin/npm',
		'node_modules/npm/bin/npm-cli.js',
		'/usr/bin/npm'
	]);
	const commands = [];
	const host = createHost({
		platform: 'linux',
		execPath: '/usr/bin/node',
		packageRoot: NPM_PACKAGE,
		currentVersion: '0.3.4',
		env: {
			PATH: 'node_modules/.bin:/usr/bin',
			npm_execpath: 'node_modules/npm/bin/npm-cli.js'
		},
		isFile: (file) => files.has(file),
		tmpdir: () => '/tmp',
		homedir: () => '/home/user',
		realpath: (file) => file,
		runCommand: async (command, args) => {
			commands.push({ command, args });
			if (args.includes('root') && args.includes('-g')) {
				assert.equal(command, '/usr/bin/npm');
				return { status: 0, stdout: NPM_ROOT, stderr: '' };
			}
			return { status: 1, stdout: '', stderr: '' };
		},
		writeStdout() {},
		writeStderr() {}
	});
	const install = await detectInstall(host);
	assert.equal(install.supported, true);
	assert.equal(install.command, '/usr/bin/npm');
});

test('accepts HTTPS registry URLs and rejects insecure or malformed overrides', () => {
	assert.equal(registryUrl({}), 'https://registry.npmjs.org');
	assert.equal(
		registryUrl({ npm_config_registry: 'https://example.invalid/npm/' }),
		'https://example.invalid/npm'
	);
	assert.equal(
		registryUrl({ NPM_CONFIG_REGISTRY: 'https://example.invalid/npm/' }),
		'https://example.invalid/npm'
	);
	for (const value of ['http://example.invalid', 'file:///tmp', 'not a URL', 'https://host/?q=1']) {
		assert.throws(() => registryUrl({ npm_config_registry: value }), /HTTPS/);
		assert.throws(() => registryUrl({ NPM_CONFIG_REGISTRY: value }), /HTTPS/);
	}
	assert.throws(
		() =>
			registryUrl({
				npm_config_registry: 'https://registry.npmjs.org',
				NPM_CONFIG_REGISTRY: 'http://example.invalid'
			}),
		/HTTPS/
	);
	assert.equal(
		channelManifestUrl('https://registry.npmjs.org', 'latest'),
		'https://registry.npmjs.org/%40spikonado%2Fsprocket/latest'
	);
	assert.equal(
		channelManifestUrl('https://registry.npmjs.org', 'canary'),
		'https://registry.npmjs.org/%40spikonado%2Fsprocket/canary'
	);
});

test('insecure registry overrides cannot fetch a version or run an install', async () => {
	const { host, commands, fetched } = testHost({
		env: { PATH: '/usr/bin', npm_config_registry: 'http://example.invalid' },
		executables: { npm: '/usr/bin/npm' }
	});
	const result = await installUpdate(host);
	assert.equal(result.status, 'error');
	assert.match(result.error, /HTTPS/);
	assert.equal(fetched.length, 0);
	assert.equal(
		commands.some(({ args }) => isInstallArgs(args)),
		false
	);
});

test('registry checks disallow redirects rather than risk an HTTP downgrade', async () => {
	const { host } = testHost({
		executables: { npm: '/usr/bin/npm' },
		fetch: async (_url, options) => {
			assert.equal(options.redirect, 'error');
			return jsonResponse(versionDoc('0.3.5'));
		}
	});
	assert.equal((await checkForUpdate(host)).status, 'available');
});

test('update-api.js prints only JSON and rejects unknown commands', () => {
	const result = spawnSync(
		process.execPath,
		[path.resolve(import.meta.dirname, '../lib/update-api.js'), 'nope'],
		{ encoding: 'utf8' }
	);
	assert.equal(result.status, 1);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.status, 'error');
	assert.equal(payload.method, 'package');
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(payload.currentVersion, manifest.version);
	assert.equal(payload.version, null);
	assert.equal(payload.error.length > 0, true);
});

test('payload helper always includes method package', () => {
	assert.deepEqual(makePayload({ status: 'idle', currentVersion: '1.0.0' }), {
		status: 'idle',
		currentVersion: '1.0.0',
		version: null,
		error: null,
		method: 'package',
		message: null
	});
});
