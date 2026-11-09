// Releases a new KiCad connector version to a GitHub release of this repository and pins it in
// releases.json. A release holds the newest KiCad nightly that has every platform's build, a kipy
// wheel and KiCadRoutingTools. A new kipy commit, KiCadRoutingTools release or change to the build
// files bumps the minor version, and a new KiCad nightly alone bumps the patch version.
// Needs bun, curl, gh, git, tar, unzip, uv, minisign, osslsigncode, rcodesign, and dwarfsextract.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	copyFileSync,
	createReadStream,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = process.env.GITHUB_REPOSITORY ?? 'spikonado/sprocket';

const BUCKET = 'https://kicad-downloads.s3.cern.ch';

const KIPY_REPOSITORY = 'https://gitlab.com/kicad/code/kicad-python';

const ROUTING_TOOLS_REPOSITORY = 'drandyhaas/KiCadRoutingTools';

// Upstream builds grid_router only for these platforms.
const ROUTING_TOOLS_BINARIES = {
	'darwin-arm64': 'grid_router-macos-arm64.so',
	'darwin-x64': 'grid_router-macos-x86_64.so',
	'linux-x64': 'grid_router-linux-x86_64.so',
	'win32-x64': 'grid_router-windows-x86_64.pyd'
};

const ROUTING_TOOLS_MARKER =
	"sys_platform == 'darwin' or (sys_platform == 'linux' and platform_machine == 'x86_64') or (sys_platform == 'win32' and platform_machine == 'AMD64')";

const PYTHON = '3.12';

// From https://kicad-downloads.s3.cern.ch/appimage/nightly/latest.json: current and next.
const MINISIGN_KEYS = [
	'RWSyix0AVvjWQGZChX64ywBpE5XqV1Eg+ZXYHR3Y27md9EoZ0AtVr9i9',
	'RWRnfcjl00yhHWT7UZlxbQzENG6+ssy/5EGXX9qi+bXha+ErCjEPkQM5'
];

const WINDOWS_SIGNER = 'CN=KICAD SERVICES CORPORATION';

const APPLE_SIGNER = 'Developer ID Application: KiCad Services Corporation (9FQDHNY6U2)';

const toolDir = dirname(fileURLToPath(import.meta.url));

const releasesPath = join(toolDir, 'releases.json');

const requirementsPath = join(toolDir, 'requirements.txt');

const TAG_PREFIX = 'kicad-connector-v';

const BUILD_FILES = [
	'update-release.mjs',
	'kipy-cli-env.patch',
	'kipy-item-results.patch',
	'routing-tools-transform-pose.patch'
];

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		...options
	});
}

async function listKeys(prefix) {
	const keys = [];
	let token = '';

	do {
		const params = new URLSearchParams({ 'list-type': '2', prefix });

		if (token) {
			params.set('continuation-token', token);
		}

		const response = await fetch(`${BUCKET}/?${params}`);

		if (!response.ok) {
			throw new Error(`Listing ${prefix} failed: ${response.status}`);
		}

		const xml = await response.text();
		keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]));
		token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? '';
	} while (token);

	return new Set(keys);
}

async function newestCompleteBuild() {
	const [linux, windows, macos] = await Promise.all(
		['appimage/nightly/', 'windows/nightly/', 'osx/nightly/'].map(listKeys)
	);

	const builds = [...linux]
		.flatMap((key) => {
			const match = key.match(
				/^appimage\/nightly\/kicad-nightly-((\d+\.\d+\.\d+)\.(\d+)\.g([0-9a-f]+))-x86_64\.AppImage\.tar$/
			);

			if (!match) {
				return [];
			}

			const [, fileVersion, base, number, commit] = match;
			const dmg = new RegExp(`^osx/nightly/kicad-unified-universal-\\d{8}-\\d{4}-${commit}\\.dmg$`);

			return [
				{
					fileVersion,
					commit,
					version: `${base}-${number}-g${commit}`,
					dmg: [...macos].find((candidate) => dmg.test(candidate))
				}
			];
		})
		.sort((a, b) => b.fileVersion.localeCompare(a.fileVersion, 'en', { numeric: true }));

	return builds.find(
		({ fileVersion, dmg }) =>
			dmg &&
			linux.has(`appimage/nightly/kicad-nightly-${fileVersion}-x86_64.AppImage.minisig`) &&
			windows.has(`windows/nightly/kicad-nightly-${fileVersion}-x86_64.exe`) &&
			windows.has(`windows/nightly/kicad-nightly-${fileVersion}-arm64.exe`)
	);
}

function download(url, directory) {
	const path = join(directory, basename(url));
	run('curl', [
		'--fail',
		'--silent',
		'--show-error',
		'--location',
		'--retry',
		'3',
		'--output',
		path,
		url
	]);

	return path;
}

async function sha256(path, end) {
	const hash = createHash('sha256');

	for await (const chunk of createReadStream(path, { end })) {
		hash.update(chunk);
	}

	return hash.digest('hex');
}

function verifyAppImage(appImage, signature, fileVersion) {
	const verified = MINISIGN_KEYS.some((key) => {
		try {
			return run('minisign', ['-V', '-P', key, '-m', appImage, '-x', signature]).includes(
				`Trusted comment: KiCad-${fileVersion}-x86_64.AppImage`
			);
		} catch {
			return false;
		}
	});

	if (!verified) {
		throw new Error(`${basename(appImage)} has no valid KiCad minisign signature`);
	}
}

function verifyExe(exe) {
	// The GlobalSign code signing root is not in the system TLS bundle; the timestamp root is.
	const output = run('osslsigncode', [
		'verify',
		'-CAfile',
		join(toolDir, 'globalsign-code-signing-root-r45.pem'),
		'-TSA-CAfile',
		'/etc/ssl/certs/ca-certificates.crt',
		'-in',
		exe
	]);

	if (
		!new RegExp(
			`Signer's certificate:\\s+-+\\s+Signer #0:\\s+Subject: [^\\n]*${WINDOWS_SIGNER},`
		).test(output)
	) {
		throw new Error(`${basename(exe)} is not signed by ${WINDOWS_SIGNER}`);
	}
}

function readAt(fd, offset, length) {
	const buffer = Buffer.alloc(length);
	readSync(fd, buffer, 0, length, offset);

	return buffer;
}

// rcodesign checks the CMS signature and certificate chain but cannot verify a DMG's contents,
// so this checks that the signed code directory covers the whole image and its trailer.
async function verifyDmg(dmg) {
	const info = run('rcodesign', ['print-signature-info', dmg]);
	const [certificates, signers] = info.split('\n          signers:\n');
	const bag = certificates.split('- subject: ').slice(1);

	const isKiCad = (certificate) =>
		certificate.includes(APPLE_SIGNER) && certificate.includes('chains_to_apple_root_ca: true');

	const signer = signers?.match(
		/^\s+- issuer: [^\n]*\n[\s\S]*?message_digest: ([0-9a-f]+)[\s\S]*?signature_verifies: (\w+)/
	);

	// rcodesign verifies the signature only against certificates in the bag, so allowing just
	// Apple CAs and KiCad's certificate there ties the signer to KiCad.
	if (
		!bag.some(isKiCad) ||
		!bag.every(
			(certificate) =>
				isKiCad(certificate) || /is_apple_(root|intermediate)_ca: true/.test(certificate)
		) ||
		signer?.[2] !== 'true'
	) {
		throw new Error(`${basename(dmg)} is not signed by ${APPLE_SIGNER}`);
	}

	if (!info.includes(`identifier: ${basename(dmg, '.dmg')}\n`)) {
		throw new Error(`${basename(dmg)} was signed under another name`);
	}

	const fd = openSync(dmg, 'r');
	const koly = readAt(fd, statSync(dmg).size - 512, 512);
	const signatureOffset = Number(koly.readBigUInt64BE(296));
	const superblob = readAt(fd, signatureOffset, Number(koly.readBigUInt64BE(304)));
	closeSync(fd);
	const blobCount = superblob.readUInt32BE(8);

	const indexEntry = [...Array(blobCount).keys()].find(
		(index) => superblob.readUInt32BE(12 + index * 8) === 0
	);

	const start = superblob.readUInt32BE(16 + indexEntry * 8);
	const directory = superblob.subarray(start, start + superblob.readUInt32BE(start + 4));
	const hashOffset = directory.readUInt32BE(16);

	const slot = (index) =>
		directory.subarray(hashOffset + index * 32, hashOffset + (index + 1) * 32).toString('hex');

	koly.writeBigUInt64BE(koly.readBigUInt64BE(216) + koly.readBigUInt64BE(224), 296);
	koly.writeBigUInt64BE(0n, 304);

	if (
		createHash('sha256').update(directory).digest('hex') !== signer[1] ||
		directory.readUInt32BE(28) !== 1 ||
		directory.readUInt32BE(32) !== signatureOffset ||
		directory[37] !== 2 ||
		slot(0) !== (await sha256(dmg, signatureOffset - 1)) ||
		slot(-6) !== createHash('sha256').update(koly).digest('hex')
	) {
		throw new Error(`${basename(dmg)} does not match its code signature`);
	}
}

function buildKipy(work, expectedCommit) {
	const source = join(work, 'kicad-python');
	run('git', [
		'clone',
		'--quiet',
		'--depth',
		'1',
		'--recurse-submodules',
		'--shallow-submodules',
		KIPY_REPOSITORY,
		source
	]);
	const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();

	if (commit !== expectedCommit) {
		throw new Error(`kicad-python moved from ${expectedCommit} to ${commit} meanwhile; rerun`);
	}

	run('git', ['-C', source, 'apply', join(toolDir, 'kipy-cli-env.patch')]);
	// When this stops applying because upstream fixed the double unpack, delete the patch.
	run('git', ['-C', source, 'apply', join(toolDir, 'kipy-item-results.patch')]);
	// Poetry emits a platform wheel; the build script writes the pure one to the source's dist.
	run(
		'uv',
		['build', '--wheel', '--python', PYTHON, '--out-dir', join(work, 'poetry-dist'), source],
		{ stdio: ['ignore', 'ignore', 'inherit'] }
	);

	const wheel = readdirSync(join(source, 'dist')).find((name) =>
		name.endsWith('-py3-none-any.whl')
	);

	const path = join(work, wheel);
	renameSync(join(source, 'dist', wheel), path);

	return path;
}

// Route.py loads `rust_router/grid_router`, which only the KiCad plugin's loader copies from the
// platform's binary, so each platform gets its own archive with the binary under that name.
async function buildRoutingTools(work, release) {
	const version = release.tag_name.replace(/^v/, '');
	const asset = release.assets.find(({ name }) => name === `KiCadRoutingTools-${version}.zip`);
	const zip = download(asset.browser_download_url, work);

	if (`sha256:${await sha256(zip)}` !== asset.digest) {
		throw new Error(`${asset.name} does not match its release digest`);
	}

	run('unzip', ['-q', zip, 'plugins/*', '-d', work]);
	rmSync(zip);
	const tree = join(work, 'routing-tools');
	renameSync(join(work, 'plugins'), tree);
	// When this stops applying because upstream released it, delete the patch.
	run('git', ['apply', join(toolDir, 'routing-tools-transform-pose.patch')], { cwd: tree });
	// The boards belong to other projects and the agent skills to upstream's harness.
	rmSync(join(tree, '.claude'), { recursive: true, force: true });

	for (const path of readdirSync(tree, { recursive: true })) {
		if (/\.kicad_(pcb|pro)(\.gz)?$/.test(path)) {
			rmSync(join(tree, path));
		}
	}

	const archives = Object.fromEntries(
		Object.entries(ROUTING_TOOLS_BINARIES).map(([platform, binary]) => {
			const loaded = join(tree, 'rust_router', `grid_router${extname(binary)}`);

			copyFileSync(join(tree, 'rust_router', binary), loaded);
			const archive = join(work, `kicad-routing-tools-${version}-${platform}.tar.gz`);
			run('tar', ['-czf', archive, '--exclude=grid_router-*', '-C', tree, '.']);
			rmSync(loaded);

			return [platform, archive];
		})
	);

	rmSync(tree, { recursive: true });

	return archives;
}

function compileRequirements(wheel, path) {
	// Pillow is for kicad-view, which renders with KiCadRoutingTools.
	const routingTools = ['numpy', 'scipy', 'shapely', 'pillow'].map(
		(name) => `${name} ; ${ROUTING_TOOLS_MARKER}`
	);

	// Agents read datasheets with PyMuPDF and plot with matplotlib. PyMuPDF 2 adds onnxruntime
	// and drops the Intel macOS and Windows on Arm wheels.
	const agentTools = ['matplotlib', 'pymupdf<2'];

	run(
		'uv',
		[
			'pip',
			'compile',
			'--universal',
			'--generate-hashes',
			'--python-version',
			PYTHON,
			'--no-header',
			'--no-annotate',
			'--no-emit-package',
			'kicad-python',
			'--output-file',
			path,
			'-'
		],
		{ input: [`kicad-python @ file://${wheel}`, ...routingTools, ...agentTools, ''].join('\n') }
	);
}

function smokeTest(work, appImage, wheel, requirements, routingToolsArchive) {
	const kicad = join(work, 'kicad');
	const venv = join(work, 'venv');
	const routingTools = join(work, 'routing-tools');
	mkdirSync(kicad);
	mkdirSync(routingTools);
	run('tar', ['-xzf', routingToolsArchive, '-C', routingTools]);
	run('dwarfsextract', [
		'--input',
		appImage,
		'--image-offset',
		'auto',
		'--output',
		kicad,
		'--log-level',
		'error'
	]);
	run('uv', ['venv', '--quiet', '--managed-python', '--python', PYTHON, venv]);
	run('uv', [
		'pip',
		'install',
		'--quiet',
		'--python',
		venv,
		'--require-hashes',
		'--requirement',
		requirements
	]);
	run('uv', ['pip', 'install', '--quiet', '--python', venv, '--no-deps', wheel]);
	run(
		join(venv, 'bin', 'python'),
		[join(toolDir, 'smoke-test.py'), join(kicad, 'share', 'kicad', 'template'), routingTools],
		{
			env: { ...process.env, KICAD_CLI_PATH: join(kicad, 'bin', 'kicad-cli') },
			stdio: ['ignore', 'inherit', 'inherit']
		}
	);
	rmSync(kicad, { recursive: true, force: true });
	rmSync(venv, { recursive: true, force: true });
	rmSync(routingTools, { recursive: true, force: true });
}

function publishedRelease(tag) {
	try {
		return JSON.parse(
			run('gh', ['api', `repos/${REPOSITORY}/releases/tags/${tag}`], { stdio: 'pipe' })
		);
	} catch (error) {
		if (error.stdout?.includes('"status":"404"')) {
			return undefined;
		}

		throw error;
	}
}

function lastCommit(paths) {
	return run('git', ['log', '-1', '--format=%H', '--', ...paths], { cwd: toolDir }).trim();
}

function changedSince(commit, paths) {
	const changed = run('git', ['diff', '--name-only', commit, 'HEAD', '--', ...paths], {
		cwd: toolDir
	});

	return changed.trim() !== '';
}

function nextVersion(pinned, bump) {
	const [major, minor, patch] = pinned.split('.').map(Number);

	return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function releaseNotes(build, kipyCommit, routingToolsRelease, buildCommit) {
	return [
		`Unmodified upstream KiCad nightly builds of commit ${build.commit}, downloaded from ${BUCKET} after checking each platform's signature.`,
		'',
		`Corresponding source: https://gitlab.com/kicad/code/kicad/-/tree/${build.commit}`,
		'',
		`The kicad-python wheel is built from ${KIPY_REPOSITORY}/-/tree/${kipyCommit} with two patches: \`find_kicad_cli()\` uses \`KICAD_CLI_PATH\` when given no path, and \`create_items()\` and \`update_items()\` stop unpacking each returned item twice.`,
		'',
		`The \`kicad-routing-tools-*\` archives are https://github.com/${ROUTING_TOOLS_REPOSITORY}/releases/tag/${routingToolsRelease.tag_name} with one patch that reads the footprint poses of board format 20260616 and later, without its example boards. Each holds its platform's \`grid_router\` binary.`,
		'',
		'`requirements.txt` pins the Python dependencies of both.',
		'',
		`Built by https://github.com/${REPOSITORY}/tree/${buildCommit}/tools/kicad.`
	].join('\n');
}

async function createRelease(tag, notes, build, kipyCommit, routingToolsRelease) {
	const work = mkdtempSync(join(tmpdir(), 'kicad-'));

	try {
		const tar = download(
			`${BUCKET}/appimage/nightly/kicad-nightly-${build.fileVersion}-x86_64.AppImage.tar`,
			work
		);

		const signature = download(
			`${BUCKET}/appimage/nightly/kicad-nightly-${build.fileVersion}-x86_64.AppImage.minisig`,
			work
		);

		run('tar', ['-xf', tar, '-C', work]);
		rmSync(tar);
		const appImage = join(work, `kicad-nightly-${build.fileVersion}-x86_64.AppImage`);
		verifyAppImage(appImage, signature, build.fileVersion);

		const kipy = buildKipy(work, kipyCommit);
		const requirements = join(work, 'requirements.txt');
		compileRequirements(kipy, requirements);
		const routingTools = await buildRoutingTools(work, routingToolsRelease);
		smokeTest(work, appImage, kipy, requirements, routingTools['linux-x64']);

		const exes = ['x86_64', 'arm64'].map((arch) =>
			download(`${BUCKET}/windows/nightly/kicad-nightly-${build.fileVersion}-${arch}.exe`, work)
		);

		exes.forEach(verifyExe);
		const dmg = download(`${BUCKET}/${build.dmg}`, work);
		await verifyDmg(dmg);

		// gh uploads the assets to a draft and publishes it only once all are in.
		run(
			'gh',
			[
				'release',
				'create',
				tag,
				'--repo',
				REPOSITORY,
				'--prerelease',
				'--latest=false',
				'--title',
				`KiCad connector v${tag.slice(TAG_PREFIX.length)}`,
				'--notes',
				notes,
				appImage,
				...exes,
				dmg,
				kipy,
				...Object.values(routingTools),
				requirements
			],
			{ stdio: ['ignore', 'inherit', 'inherit'] }
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	return publishedRelease(tag);
}

const build = await newestCompleteBuild();

if (!build) {
	throw new Error('No KiCad nightly has builds for every platform');
}

const kipyCommit = run('git', ['ls-remote', KIPY_REPOSITORY, 'HEAD']).split('\t')[0];

const routingToolsRelease = JSON.parse(
	run('gh', ['api', `repos/${ROUTING_TOOLS_REPOSITORY}/releases/latest`])
);

const routingToolsVersion = routingToolsRelease.tag_name.replace(/^v/, '');

const pinned = JSON.parse(await readFile(releasesPath, 'utf8'));

const buildCommit = lastCommit(BUILD_FILES);

const buildChanged =
	changedSince(lastCommit(['releases.json']), BUILD_FILES) ||
	pinned.kipy.commit !== kipyCommit ||
	pinned.routingTools.version !== routingToolsVersion;

if (!buildChanged && pinned.kicad.version === build.version) {
	console.log(`KiCad connector v${pinned.version} is current.`);
	process.exit(0);
}

const notes = releaseNotes(build, kipyCommit, routingToolsRelease, buildCommit);

let version = nextVersion(pinned.version, buildChanged ? 'minor' : 'patch');

let release = publishedRelease(`${TAG_PREFIX}${version}`);

// An unmerged update's version may already be installed for testing, so other contents get the
// next free version instead of replacing it.
while (release && release.body?.trim() !== notes) {
	version = nextVersion(version, 'patch');
	release = publishedRelease(`${TAG_PREFIX}${version}`);
}

const tag = `${TAG_PREFIX}${version}`;

release ??= await createRelease(tag, notes, build, kipyCommit, routingToolsRelease);

function asset(suffix) {
	const published = release.assets.find((candidate) => candidate.name.endsWith(suffix));

	if (!published?.digest?.startsWith('sha256:')) {
		throw new Error(`${tag} has no ${suffix} asset with a digest`);
	}

	return {
		url: published.browser_download_url,
		bytes: published.size,
		sha256: published.digest.slice('sha256:'.length)
	};
}

const dmg = asset('.dmg');

const platforms = {
	'darwin-arm64': dmg,
	'darwin-x64': dmg,
	'linux-x64': asset('-x86_64.AppImage'),
	'win32-arm64': asset('-arm64.exe'),
	'win32-x64': asset('-x86_64.exe')
};

const routingTools = {
	version: routingToolsVersion,
	platforms: Object.fromEntries(
		Object.keys(ROUTING_TOOLS_BINARIES).map((platform) => [platform, asset(`-${platform}.tar.gz`)])
	)
};

const requirements = await fetch(asset('requirements.txt').url);

if (!requirements.ok) {
	throw new Error(`Downloading ${tag} requirements.txt failed: ${requirements.status}`);
}

await writeFile(requirementsPath, await requirements.text());

await writeFile(
	releasesPath,
	`${JSON.stringify({ version, kicad: { version: build.version, commit: build.commit }, platforms, kipy: { commit: kipyCommit, ...asset('-py3-none-any.whl') }, routingTools }, null, '\t')}\n`
);

console.log(`Pinned KiCad connector v${version}.`);
