// Mirrors the newest KiCad nightly that has every platform's build to a GitHub release of this
// repository, along with a kipy wheel, then pins that release in releases.json.
// Needs bun, curl, gh, git, tar, uv, minisign, osslsigncode, rcodesign, and dwarfsextract.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = process.env.GITHUB_REPOSITORY ?? 'spikonado/sprocket';

const BUCKET = 'https://kicad-downloads.s3.cern.ch';

const KIPY_REPOSITORY = 'https://gitlab.com/kicad/code/kicad-python';

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

function download(key, directory) {
	const path = join(directory, basename(key));
	run('curl', [
		'--fail',
		'--silent',
		'--show-error',
		'--location',
		'--retry',
		'3',
		'--output',
		path,
		`${BUCKET}/${key}`
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
	const leaf = info.split('- subject: ').find((certificate) => certificate.includes(APPLE_SIGNER));

	const signer = info.match(
		/ {10}signers:\n\s+- issuer: CN=Developer ID Certification Authority[^\n]*\n[\s\S]*?message_digest: ([0-9a-f]+)[\s\S]*?signature_verifies: (\w+)/
	);

	if (!leaf?.includes('chains_to_apple_root_ca: true') || signer?.[2] !== 'true') {
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

function buildKipy(work) {
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
	run('git', ['-C', source, 'apply', join(toolDir, 'kipy-cli-env.patch')]);
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
	const commit = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();

	return { path, commit };
}

function compileRequirements(wheel, path) {
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
		{ input: `kicad-python @ file://${wheel}\n` }
	);
}

function smokeTest(work, appImage, wheel, requirements) {
	const kicad = join(work, 'kicad');
	const venv = join(work, 'venv');
	mkdirSync(kicad);
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
		[join(toolDir, 'smoke-test.py'), join(kicad, 'share', 'kicad', 'template')],
		{
			env: { ...process.env, KICAD_CLI_PATH: join(kicad, 'bin', 'kicad-cli') },
			stdio: ['ignore', 'inherit', 'inherit']
		}
	);
	rmSync(kicad, { recursive: true, force: true });
	rmSync(venv, { recursive: true, force: true });
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

async function createRelease(build, tag) {
	const work = mkdtempSync(join(tmpdir(), 'kicad-'));

	try {
		const tar = download(
			`appimage/nightly/kicad-nightly-${build.fileVersion}-x86_64.AppImage.tar`,
			work
		);

		const signature = download(
			`appimage/nightly/kicad-nightly-${build.fileVersion}-x86_64.AppImage.minisig`,
			work
		);

		run('tar', ['-xf', tar, '-C', work]);
		rmSync(tar);
		const appImage = join(work, `kicad-nightly-${build.fileVersion}-x86_64.AppImage`);
		verifyAppImage(appImage, signature, build.fileVersion);

		const kipy = buildKipy(work);
		const requirements = join(work, 'requirements.txt');
		compileRequirements(kipy.path, requirements);
		smokeTest(work, appImage, kipy.path, requirements);

		const exes = ['x86_64', 'arm64'].map((arch) =>
			download(`windows/nightly/kicad-nightly-${build.fileVersion}-${arch}.exe`, work)
		);

		exes.forEach(verifyExe);
		const dmg = download(build.dmg, work);
		await verifyDmg(dmg);

		const notes = [
			`Unmodified upstream KiCad nightly builds of commit ${build.commit}, downloaded from ${BUCKET} after checking each platform's signature.`,
			'',
			`Corresponding source: https://gitlab.com/kicad/code/kicad/-/tree/${build.commit}`,
			'',
			`\`${basename(kipy.path)}\` is kicad-python built from ${KIPY_REPOSITORY}/-/tree/${kipy.commit} with one patch: \`find_kicad_cli()\` uses \`KICAD_CLI_PATH\` when given no path. \`requirements.txt\` pins its dependencies.`
		].join('\n');

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
				`KiCad ${build.version}`,
				'--notes',
				notes,
				appImage,
				...exes,
				dmg,
				kipy.path,
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

const pinned = await readFile(releasesPath, 'utf8').then(JSON.parse, () => undefined);

if (pinned?.version === build.version) {
	console.log(`KiCad ${build.version} is already pinned.`);
	process.exit(0);
}

const tag = `kicad-${build.version}`;

const release = publishedRelease(tag) ?? (await createRelease(build, tag));

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

const requirements = await fetch(asset('requirements.txt').url);

if (!requirements.ok) {
	throw new Error(`Downloading ${tag} requirements.txt failed: ${requirements.status}`);
}

await writeFile(requirementsPath, await requirements.text());

await writeFile(
	releasesPath,
	`${JSON.stringify({ version: build.version, commit: build.commit, platforms, kipy: asset('-py3-none-any.whl') }, null, '\t')}\n`
);

console.log(`Pinned KiCad ${build.version}.`);
