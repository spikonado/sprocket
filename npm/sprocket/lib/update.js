import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsPromises, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = '@spikonado/sprocket';
export const UPDATE_API_FILENAME = 'update-api.js';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const RELAUNCH_MESSAGE =
	'Wait for active agents to finish, then stop Sprocket and launch it again.';
export const UNSUPPORTED_MESSAGE =
	'This copy of Sprocket was not installed globally with npm, bun, pnpm, or yarn, so it cannot be updated in place.';

const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const CANARY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const DEV_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9a-f]{40}$/;
const NUMERIC_IDENTIFIER = /^[0-9]+$/;
const QUERY_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const KILL_WAIT_MS = 5_000;
const OUTPUT_LIMIT = 1_000_000;

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

const MANAGERS = [
	{
		name: 'bun',
		queryArgs: ['pm', 'bin', '--global'],
		installArgs: (version) => ['add', '--global', packageSpec(version)],
		globalRoot(queryStdout) {
			const binDir = firstAbsolutePath(queryStdout);
			return binDir ? path.resolve(binDir, '..', 'install', 'global', 'node_modules') : '';
		}
	},
	{
		name: 'pnpm',
		queryArgs: ['root', '-g'],
		installArgs: (version) => ['add', '--global', packageSpec(version)],
		globalRoot(queryStdout) {
			return firstAbsolutePath(queryStdout);
		}
	},
	{
		name: 'yarn',
		queryArgs: ['global', 'dir'],
		installArgs: (version) => ['global', 'add', packageSpec(version)],
		globalRoot(queryStdout) {
			const dir = firstAbsolutePath(queryStdout);
			return dir ? path.join(dir, 'node_modules') : '';
		}
	},
	{
		name: 'npm',
		queryArgs: ['root', '-g'],
		installArgs: (version) => ['install', '--global', packageSpec(version)],
		globalRoot(queryStdout) {
			return firstAbsolutePath(queryStdout);
		}
	}
];

export function packageSpec(version) {
	return `${PACKAGE_NAME}@${version}`;
}

export function asText(value) {
	if (value == null) {
		return '';
	}
	return `${value}`;
}

export function parseVersionField(value) {
	const text = asText(value).trim();
	if (!text || text.length > 128) {
		return '';
	}
	return text;
}

export function releaseChannel(version) {
	const text = asText(version);
	if (text.includes('-canary.')) {
		return 'canary';
	}
	if (text.includes('-dev.')) {
		return 'dev';
	}
	return 'latest';
}

export function isAllowedVersion(version, channel) {
	const text = parseVersionField(version);
	if (!text) {
		return false;
	}
	if (channel === 'canary') {
		return CANARY_VERSION.test(text);
	}
	if (channel === 'dev') {
		return DEV_VERSION.test(text);
	}
	return STABLE_VERSION.test(text);
}

export function compareReleaseVersions(left, right) {
	const parsedLeft = parseComparable(left);
	const parsedRight = parseComparable(right);
	if (!parsedLeft || !parsedRight) {
		return null;
	}
	for (let index = 0; index < 3; index += 1) {
		if (parsedLeft.core[index] < parsedRight.core[index]) {
			return -1;
		}
		if (parsedLeft.core[index] > parsedRight.core[index]) {
			return 1;
		}
	}
	return comparePrerelease(parsedLeft.pre, parsedRight.pre);
}

export function channelUpdate(currentVersion, registryVersion) {
	if (currentVersion === registryVersion) {
		return { status: 'idle' };
	}
	if (releaseChannel(currentVersion) === 'dev') {
		return { status: 'available', version: registryVersion };
	}
	const comparison = compareReleaseVersions(registryVersion, currentVersion);
	if (comparison == null) {
		throw new Error('Could not compare the installed version with the registry version.');
	}
	if (comparison <= 0) {
		return { status: 'idle' };
	}
	return { status: 'available', version: registryVersion };
}

export function makePayload(fields) {
	return {
		status: fields.status,
		currentVersion: fields.currentVersion,
		version: fields.version ?? null,
		error: fields.error ?? null,
		method: 'package',
		message: fields.message ?? null
	};
}

export function parseUpdateArgs(args) {
	const command = args[0];
	if (command !== 'update' && command !== 'upgrade') {
		return { kind: 'none' };
	}
	let check = false;
	for (const arg of args.slice(1)) {
		if (arg === '--help' || arg === '-h') {
			return { kind: 'native' };
		}
		if (arg === '--check') {
			check = true;
			continue;
		}
		return { kind: 'invalid', error: `Unknown option '${arg}'.` };
	}
	return { kind: 'run', check };
}

export function globalPackageDir(globalRoot) {
	return path.join(globalRoot, '@spikonado', 'sprocket');
}

export function isManagedUpdate(env = {}) {
	return asText(env.SPROCKET_UPDATE_MANAGED) === '1';
}

export function taskkillPath(env = {}) {
	const root = asText(env.SystemRoot || env.SYSTEMROOT);
	if (!path.win32.isAbsolute(root))
		throw new Error('SystemRoot is unavailable; cannot stop the update process tree.');
	return path.win32.join(root, 'System32', 'taskkill.exe');
}

export function timeoutRecoveryMessage(lockPath) {
	return `Timed out while installing the update. Confirm no package manager is still running, delete ${lockPath}, then retry.`;
}

export function updateLockPath(host, globalRoot) {
	const resolved = path.resolve(globalPackageDir(globalRoot));
	const identity = host.platform === 'win32' ? resolved.toLowerCase() : resolved;
	const id = createHash('sha256').update(identity).digest('hex').slice(0, 16);
	return path.join(host.tmpdir(), `sprocket-update-${id}.lock`);
}

export function waitForClose(child, deadlineMs) {
	return new Promise((resolve, reject) => {
		if (child.exitCode != null || child.signalCode != null) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			child.off?.('error', fail);
			resolve();
		};
		const fail = (error) => {
			clearTimeout(timer);
			child.off?.('close', finish);
			reject(error);
		};
		const timer = setTimeout(() => {
			child.off?.('close', finish);
			child.off?.('error', fail);
			reject(new Error('process did not exit'));
		}, deadlineMs);
		if (child.once) {
			child.once('close', finish);
			child.once('error', fail);
			return;
		}
		if (child.on) {
			child.on('close', finish);
			child.on('error', fail);
			return;
		}
		clearTimeout(timer);
		resolve();
	});
}

export async function killProcessTree(child, platform = process.platform, extras = {}) {
	const pid = child?.pid;
	if (pid == null || pid <= 0) {
		return;
	}
	const deadlineMs = extras.deadlineMs ?? KILL_WAIT_MS;
	if (platform === 'win32') {
		const spawnImpl = extras.spawn ?? spawn;
		const killer = spawnImpl(
			extras.taskkillPath ?? taskkillPath(extras.env),
			['/PID', String(pid), '/T', '/F'],
			{
				shell: false,
				windowsHide: true,
				stdio: 'ignore',
				timeout: deadlineMs,
				killSignal: 'SIGKILL'
			}
		);
		await Promise.all([waitForClose(killer, deadlineMs), waitForClose(child, deadlineMs)]);
		if (killer.exitCode !== 0) throw new Error('taskkill could not stop the update process tree.');
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			child.kill('SIGKILL');
		} catch {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// The process already exited.
			}
		}
	}
}

export function createRunCommand(spawnImpl, treeKiller = killProcessTree, selfKill) {
	const killHelperGroup = selfKill ?? ((groupPid) => process.kill(groupPid, 'SIGKILL'));
	return function runCommand(command, args, options = {}) {
		return new Promise((resolve) => {
			let settled = false;
			let timingOut = false;
			let timer;
			let stdout = '';
			let stderr = '';
			const platform = options.platform ?? process.platform;
			const managed = isManagedUpdate(options.env);
			const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
			const done = (result) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};

			let child;
			try {
				child = spawnImpl(command, args, {
					cwd: options.cwd,
					env: options.env,
					shell: false,
					windowsHide: true,
					detached: platform !== 'win32' && !managed,
					stdio: ['ignore', 'pipe', 'pipe']
				});
			} catch (error) {
				done({
					status: 1,
					stdout: '',
					stderr: publicError(error),
					error,
					timedOut: false
				});
				return;
			}

			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', (chunk) => {
				stdout = appendBounded(stdout, chunk);
			});
			child.stderr?.on('data', (chunk) => {
				stderr = appendBounded(stderr, chunk);
			});
			child.on('error', (error) => {
				if (timingOut) return;
				done({
					status: 1,
					stdout,
					stderr: appendBounded(stderr, publicError(error)),
					error,
					timedOut: false
				});
			});
			child.on('close', (status) => {
				if (!timingOut) done({ status: status ?? 1, stdout, stderr, timedOut: false });
			});

			if (options.timeout) {
				timer = setTimeout(() => {
					void finishTimeout();
				}, options.timeout);
			}

			async function finishTimeout() {
				if (settled) {
					return;
				}
				timingOut = true;
				if (managed && platform !== 'win32') {
					try {
						killHelperGroup(-process.pid);
					} catch {
						// Tests inject a no-op killer; production SIGKILL does not return.
					}
					done({
						status: 1,
						stdout,
						stderr: appendBounded(stderr, 'Timed out.'),
						timedOut: true,
						uncertain: true
					});
					return;
				}
				let uncertain = false;
				try {
					await treeKiller(child, platform, {
						spawn: spawnImpl,
						env: options.env,
						deadlineMs: killWaitMs
					});
				} catch {
					uncertain = true;
				}
				child.stdout?.destroy();
				child.stderr?.destroy();
				try {
					await waitForClose(child, killWaitMs);
				} catch {
					uncertain = true;
				}
				done({
					status: 1,
					stdout,
					stderr: appendBounded(stderr, 'Timed out.'),
					timedOut: true,
					uncertain
				});
			}
		});
	};
}

export function createHost(overrides = {}) {
	const env = overrides.env ?? process.env;
	const platform = overrides.platform ?? process.platform;
	const execPath = overrides.execPath ?? process.execPath;
	const packageRoot = overrides.packageRoot ?? PACKAGE_ROOT;
	const readFile = overrides.readFile ?? ((file, encoding) => readFileSync(file, encoding));
	const isFile = overrides.isFile ?? defaultIsFile;
	const host = {
		env,
		platform,
		execPath,
		pid: overrides.pid ?? process.pid,
		packageRoot,
		currentVersion: overrides.currentVersion,
		tmpdir: overrides.tmpdir ?? (() => os.tmpdir()),
		homedir: overrides.homedir ?? (() => os.homedir()),
		fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
		runCommand: overrides.runCommand ?? createRunCommand(overrides.spawn ?? spawn),
		isFile,
		readFile,
		realpath: overrides.realpath ?? defaultRealpath,
		findExecutable:
			overrides.findExecutable ?? ((name) => findExecutable(name, env, platform, isFile)),
		open: overrides.open ?? ((file, flags) => fsPromises.open(file, flags)),
		unlink: overrides.unlink ?? ((file) => fsPromises.unlink(file)),
		writeStdout: overrides.writeStdout ?? ((text) => process.stdout.write(text)),
		writeStderr: overrides.writeStderr ?? ((text) => process.stderr.write(text))
	};
	if (host.currentVersion === undefined) {
		host.currentVersion = readCurrentVersion(host);
	}
	return host;
}

export function readCurrentVersion(host) {
	const configured = parseVersionField(host.currentVersion);
	if (configured) {
		return configured;
	}
	try {
		const manifest = JSON.parse(host.readFile(path.join(host.packageRoot, 'package.json'), 'utf8'));
		return parseVersionField(manifest?.version);
	} catch {
		return '';
	}
}

export async function detectInstall(host) {
	const packageRoot = path.resolve(host.packageRoot);
	for (const manager of MANAGERS) {
		const invocation = resolveManagerInvocation(manager.name, host);
		if (!invocation) {
			continue;
		}
		const globalRoot = await queryGlobalRoot(manager, invocation, host);
		if (!globalRoot) {
			continue;
		}
		if (isExactGlobalPackage(packageRoot, globalRoot, host)) {
			return {
				supported: true,
				manager: manager.name,
				command: invocation.command,
				argsPrefix: invocation.argsPrefix,
				globalRoot,
				installArgs: manager.installArgs
			};
		}
	}
	return { supported: false };
}

export async function checkForUpdate(host) {
	const currentVersion = readCurrentVersion(host);
	const install = await detectInstall(host);
	if (!install.supported) {
		return makePayload({
			status: 'unavailable',
			currentVersion,
			message: UNSUPPORTED_MESSAGE
		});
	}
	const channel = releaseChannel(currentVersion);
	const registryVersion = await fetchChannelVersion(host, channel, currentVersion);
	const decision = channelUpdate(currentVersion, registryVersion);
	if (decision.status === 'idle') {
		return makePayload({ status: 'idle', currentVersion });
	}
	return makePayload({
		status: 'available',
		currentVersion,
		version: decision.version
	});
}

export async function installUpdate(host) {
	const currentVersion = readCurrentVersion(host);
	const detected = await detectInstall(host);
	if (!detected.supported) {
		return makePayload({
			status: 'unavailable',
			currentVersion,
			message: UNSUPPORTED_MESSAGE
		});
	}
	const lockPath = updateLockPath(host, detected.globalRoot);
	try {
		return await withUpdateLock(host, lockPath, async () => {
			const checked = await checkForUpdate(host);
			if (checked.status !== 'available') {
				return { payload: checked };
			}
			const install = await detectInstall(host);
			if (!install.supported) {
				return {
					payload: makePayload({
						status: 'unavailable',
						currentVersion,
						message: UNSUPPORTED_MESSAGE
					})
				};
			}
			if (!isAllowedVersion(checked.version, releaseChannel(currentVersion))) {
				return {
					payload: makePayload({
						status: 'error',
						currentVersion,
						version: checked.version,
						error: 'Refusing to install a version that failed validation.'
					})
				};
			}
			if (updateLockPath(host, install.globalRoot) !== lockPath) {
				throw new Error('The installation location changed during the update check. Try again.');
			}
			const result = await host.runCommand(
				install.command,
				[...install.argsPrefix, ...install.installArgs(checked.version)],
				{
					cwd: host.homedir(),
					env: host.env,
					platform: host.platform,
					timeout: INSTALL_TIMEOUT_MS
				}
			);
			if (result.timedOut || result.uncertain) {
				return {
					retainLock: true,
					payload: makePayload({
						status: 'error',
						currentVersion,
						version: checked.version,
						error: timeoutRecoveryMessage(lockPath)
					})
				};
			}
			if ((result.status ?? 1) !== 0) {
				return {
					payload: makePayload({
						status: 'error',
						currentVersion,
						version: checked.version,
						error: installFailureMessage(
							`${result.stderr ?? ''}\n${result.stdout ?? ''}`,
							host.platform
						)
					})
				};
			}
			return {
				payload: makePayload({
					status: 'installed',
					currentVersion,
					version: checked.version,
					message: RELAUNCH_MESSAGE
				})
			};
		});
	} catch (error) {
		return makePayload({
			status: 'error',
			currentVersion,
			error: publicError(error)
		});
	}
}

export async function runUpdateApi(command, host = createHost()) {
	const currentVersion = readCurrentVersion(host);
	try {
		if (command !== 'check' && command !== 'install') {
			return {
				exitCode: 1,
				payload: makePayload({
					status: 'error',
					currentVersion,
					error: 'Usage: check or install.'
				})
			};
		}
		const payload = command === 'check' ? await checkForUpdate(host) : await installUpdate(host);
		return {
			exitCode: payload.status === 'error' ? 1 : 0,
			payload
		};
	} catch (error) {
		return {
			exitCode: 1,
			payload: makePayload({
				status: 'error',
				currentVersion,
				error: publicError(error)
			})
		};
	}
}

export async function runUpdateCli(parsed, host = createHost()) {
	if (parsed.kind === 'invalid') {
		host.writeStderr(`sprocket: ${parsed.error}\nTry \`sprocket update --help\`.\n`);
		return 1;
	}
	try {
		const payload = parsed.check ? await checkForUpdate(host) : await installUpdate(host);
		if (payload.status === 'error') {
			host.writeStderr(`sprocket: ${payload.error}\n`);
			return 1;
		}
		host.writeStdout(formatCli(payload, parsed.check));
		return payload.status === 'unavailable' ? 1 : 0;
	} catch (error) {
		host.writeStderr(`sprocket: ${publicError(error)}\n`);
		return 1;
	}
}

export function registryUrl(env = {}) {
	const values = [env.npm_config_registry, env.NPM_CONFIG_REGISTRY]
		.map((value) => asText(value).trim())
		.filter(Boolean);
	for (const value of values) {
		let url;
		try {
			url = new URL(value);
		} catch {
			throw new Error('Package updates require a valid HTTPS npm registry URL.');
		}
		if (url.protocol !== 'https:' || /\s/.test(value) || url.search || url.hash) {
			throw new Error('Package updates require a valid HTTPS npm registry URL.');
		}
	}
	return values[0]?.replace(/\/$/, '') ?? DEFAULT_REGISTRY;
}

export function channelManifestUrl(registry, channel, name = PACKAGE_NAME) {
	const base = registry.replace(/\/$/, '');
	const encodedName = encodeURIComponent(name);
	return `${base}/${encodedName}/${encodeURIComponent(channel)}`;
}

export async function withUpdateLock(host, lockPath, operation) {
	let handle;
	try {
		handle = await host.open(lockPath, 'wx');
	} catch (error) {
		if (error?.code === 'EEXIST') {
			throw new Error(
				`Another Sprocket update is already running. If it is not, delete ${lockPath} and retry.`
			);
		}
		if (error?.code === 'EACCES' || error?.code === 'EPERM') {
			throw new Error(`Cannot write the update lock at ${lockPath}. Check permissions and retry.`);
		}
		throw error;
	}
	let retainLock = false;
	try {
		await handle.writeFile(String(host.pid));
		const outcome = await operation();
		retainLock = outcome?.retainLock === true;
		return outcome?.payload ?? outcome;
	} finally {
		await handle.close().catch(() => {});
		if (!retainLock) {
			await host.unlink(lockPath).catch(() => {});
		}
	}
}

function formatCli(payload, check) {
	if (payload.status === 'unavailable') {
		return `${payload.message ?? UNSUPPORTED_MESSAGE}\n`;
	}
	if (payload.status === 'idle') {
		return `Sprocket ${payload.currentVersion} is up to date (${releaseChannel(payload.currentVersion)} channel).\n`;
	}
	if (payload.status === 'available') {
		const lines = [
			`Sprocket ${payload.version} is available (currently ${payload.currentVersion}).`
		];
		if (check) {
			lines.push('Run `sprocket update` to install it.');
		}
		return `${lines.join('\n')}\n`;
	}
	if (payload.status === 'installed') {
		return `Updated Sprocket to ${payload.version}.\n${payload.message ?? RELAUNCH_MESSAGE}\n`;
	}
	return '';
}

async function fetchChannelVersion(host, channel, currentVersion) {
	const url = channelManifestUrl(registryUrl(host.env), channel);
	let response;
	try {
		response = await host.fetch(url, {
			redirect: 'error',
			headers: {
				accept: 'application/json',
				'user-agent': `sprocket/${currentVersion || '0'}`
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
	} catch {
		throw new Error('Could not reach the npm registry. Try again.');
	}
	if (!response.ok) {
		throw new Error(`npm registry returned HTTP ${response.status}.`);
	}
	let body;
	try {
		body = await response.json();
	} catch {
		throw new Error('npm registry returned an invalid package document.');
	}
	const version = parseVersionField(body?.version);
	if (!isAllowedVersion(version, channel)) {
		throw new Error(`npm dist-tag '${channel}' does not point at a valid ${channel} release.`);
	}
	return version;
}

function isExactGlobalPackage(packageRoot, globalRoot, host) {
	const expected = globalPackageDir(globalRoot);
	const actual = pathIdentities(host, packageRoot);
	for (const candidate of pathIdentities(host, expected)) {
		if (actual.has(candidate)) {
			return true;
		}
	}
	return false;
}

function pathIdentities(host, file) {
	const identities = new Set([normalizePath(file, host.platform)]);
	identities.add(normalizePath(tryRealpath(host, file), host.platform));
	return identities;
}

function normalizePath(file, platform) {
	const resolved = path.resolve(file);
	return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveManagerInvocation(manager, host) {
	const execDir = path.dirname(host.execPath);
	const execBase = path.basename(host.execPath, '.exe').toLowerCase();
	if (manager === 'bun' && execBase === 'bun') {
		return { command: host.execPath, argsPrefix: [] };
	}
	if (manager === 'npm') {
		const npmCli = path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
		if (host.isFile(npmCli)) {
			return { command: host.execPath, argsPrefix: [npmCli] };
		}
		const npmExecPath = asText(host.env.npm_execpath);
		if (
			npmExecPath &&
			isAbsolutePath(npmExecPath, host.platform) &&
			host.isFile(npmExecPath) &&
			/npm-cli\.js$/i.test(npmExecPath)
		) {
			return { command: host.execPath, argsPrefix: [npmExecPath] };
		}
	}
	const found = host.findExecutable(manager);
	if (!found) {
		return null;
	}
	return spawnPlan(found, manager, host);
}

function spawnPlan(binary, manager, host) {
	if (/\.(cjs|js|mjs)$/i.test(binary)) {
		return { command: host.execPath, argsPrefix: [binary] };
	}
	if (host.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
		const jsCli = jsCliBesideShim(binary, manager, host);
		if (jsCli) {
			return { command: host.execPath, argsPrefix: [jsCli] };
		}
		return null;
	}
	return { command: binary, argsPrefix: [] };
}

function jsCliBesideShim(binary, manager, host) {
	const dir = path.dirname(binary);
	const candidates =
		manager === 'npm'
			? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'npm-cli.js')]
			: manager === 'pnpm'
				? [path.join(dir, 'pnpm.cjs'), path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]
				: manager === 'yarn'
					? [path.join(dir, 'yarn.js'), path.join(dir, 'node_modules', 'yarn', 'bin', 'yarn.js')]
					: [];
	return candidates.find((candidate) => host.isFile(candidate));
}

async function queryGlobalRoot(manager, invocation, host) {
	const result = await host.runCommand(
		invocation.command,
		[...invocation.argsPrefix, ...manager.queryArgs],
		{
			cwd: host.homedir(),
			env: {
				...host.env,
				COREPACK_ENABLE_NETWORK: '0',
				COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
			},
			platform: host.platform,
			timeout: QUERY_TIMEOUT_MS
		}
	);
	if ((result.status ?? 1) !== 0) {
		return '';
	}
	const globalRoot = manager.globalRoot(result.stdout ?? '');
	if (!globalRoot || globalRoot.includes('\0')) {
		return '';
	}
	return path.resolve(globalRoot);
}

function parseComparable(version) {
	const text = asText(version);
	if (STABLE_VERSION.test(text)) {
		const [major, minor, patch] = text.split('.');
		return { core: [Number(major), Number(minor), Number(patch)], pre: [] };
	}
	if (!CANARY_VERSION.test(text)) {
		return null;
	}
	const marker = '-canary.';
	const index = text.indexOf(marker);
	const [major, minor, patch] = text.slice(0, index).split('.');
	return {
		core: [Number(major), Number(minor), Number(patch)],
		pre: ['canary', ...text.slice(index + marker.length).split('.')]
	};
}

function comparePrerelease(left, right) {
	if (left.length === 0 && right.length === 0) {
		return 0;
	}
	if (left.length === 0) {
		return 1;
	}
	if (right.length === 0) {
		return -1;
	}
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		if (index >= left.length) {
			return -1;
		}
		if (index >= right.length) {
			return 1;
		}
		const comparison = compareIdentifier(left[index], right[index]);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

function compareIdentifier(left, right) {
	const leftNumeric = NUMERIC_IDENTIFIER.test(left);
	const rightNumeric = NUMERIC_IDENTIFIER.test(right);
	if (leftNumeric && rightNumeric) {
		const delta = Number(left) - Number(right);
		if (delta < 0) {
			return -1;
		}
		if (delta > 0) {
			return 1;
		}
		return 0;
	}
	if (leftNumeric) {
		return -1;
	}
	if (rightNumeric) {
		return 1;
	}
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function installFailureMessage(output, platform) {
	if (isWindowsBusyExecutable(output, platform)) {
		return 'Windows cannot replace Sprocket while it is running. Stop Sprocket, then run `sprocket update` again.';
	}
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const useful = lines
		.filter((line) => /npm ERR!|error|ERR!|EACCES|EPERM|EBUSY|denied|ELIFECYCLE/i.test(line))
		.slice(-5);
	const detail = useful.join(' ') || 'the package manager failed';
	return `Failed to install the update: ${sanitize(detail)}`;
}

export function isWindowsBusyExecutable(output, platform) {
	if (platform !== 'win32') {
		return false;
	}
	return (
		/sprocket\.exe/i.test(output) &&
		/(?:EBUSY|EPERM|EACCES|being used by another process|resource busy|locked)/i.test(output)
	);
}

function publicError(error) {
	if (error instanceof Error) {
		return sanitize(error.message);
	}
	return sanitize(asText(error));
}

function sanitize(text) {
	return asText(text).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function isAbsolutePath(file, platform) {
	if (platform === 'win32') {
		return path.win32.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('\\\\');
	}
	return path.isAbsolute(file);
}

function findExecutable(name, env, platform, isFile) {
	const pathValue = asText(env.PATH || env.Path || env.path);
	const directories = pathValue.split(path.delimiter);
	const extensions =
		platform === 'win32'
			? asText(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
					.split(';')
					.filter(Boolean)
			: [''];
	for (const directory of directories) {
		if (!directory || !isAbsolutePath(directory, platform)) {
			continue;
		}
		if (platform === 'win32') {
			const exact = path.join(directory, name);
			if (isFile(exact)) {
				return exact;
			}
			for (const extension of extensions) {
				const candidate = path.join(directory, name + extension);
				if (isFile(candidate)) {
					return candidate;
				}
			}
			continue;
		}
		const candidate = path.join(directory, name);
		if (isFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function defaultIsFile(file) {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function defaultRealpath(file) {
	return realpathSync(file);
}

function tryRealpath(host, file) {
	try {
		return host.realpath(file);
	} catch {
		return file;
	}
}

function firstAbsolutePath(text) {
	for (const line of asText(text).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.includes('\0')) {
			continue;
		}
		if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
			return trimmed;
		}
	}
	return '';
}

function appendBounded(previous, chunk) {
	const next = previous + chunk;
	return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}
