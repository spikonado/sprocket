// Vendors third-party skills into crates/sprocket-workspace/.agents/skills via
// the pinned `skills` CLI. Vendored files are committed verbatim; never edit
// them by hand (see crates/sprocket-workspace/README.md).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_CLI = 'skills@1.5.23';
const crateDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../crates/sprocket-workspace'
);

// Bare GitHub sources install through the CLI's snapshot API, whose computedHash
// is server-computed and not locally reproducible. A /tree/<ref> URL forces the
// git-clone path, whose hash cargo test can recompute. The ref is resolved to
// the repo's default branch because the CLI's URL form requires one.
function toTreeUrl(source) {
	const shorthand = source.match(/^[\w.-]+\/[\w.-]+$/);
	if (shorthand) {
		return defaultBranchUrl(`https://github.com/${shorthand[0]}`);
	}
	const repoUrl = source.match(/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+?)\/?$/);
	if (repoUrl) {
		return defaultBranchUrl(repoUrl[1]);
	}
	return source;
}

function defaultBranchUrl(repoUrl) {
	const result = spawnSync('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], { encoding: 'utf8' });
	const branch = result.stdout?.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
	if (result.status !== 0 || !branch) {
		console.error(
			`could not resolve the default branch of ${repoUrl}; pass a full https://github.com/<owner>/<repo>/tree/<ref> URL instead`
		);
		process.exit(1);
	}
	return `${repoUrl}/tree/${branch}`;
}

const [command, ...args] = process.argv.slice(2);
let argv = null;
if (command === 'add' && args.length > 0) {
	argv = ['add', toTreeUrl(args[0]), ...args.slice(1), '-a', 'universal', '--copy', '-y'];
} else if (command === 'update') {
	argv = ['update', '--project', '-y', ...args];
}

if (!argv) {
	console.error('usage: node scripts/skills.mjs add <package> [--skill <name>]');
	console.error('       node scripts/skills.mjs update [skills...]');
	process.exit(2);
}

const result = spawnSync('bunx', [SKILLS_CLI, ...argv], {
	cwd: crateDir,
	stdio: 'inherit',
	shell: process.platform === 'win32',
	env: { ...process.env, DISABLE_TELEMETRY: '1' }
});

if (result.error) {
	console.error(`failed to run ${SKILLS_CLI}: ${result.error.message}`);
}
process.exit(result.status ?? 1);
