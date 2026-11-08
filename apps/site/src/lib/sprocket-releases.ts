import { name as npmPackageName } from '../../../../npm/sprocket/package.json';

export const SPROCKET_NPM_COMMAND = `npx ${npmPackageName}`;
export const SPROCKET_GITHUB_URL = 'https://github.com/spikonado/sprocket';
export const SPROCKET_RELEASES_LATEST_URL = `${SPROCKET_GITHUB_URL}/releases/latest`;
export const SPROCKET_NPM_URL = `https://www.npmjs.com/package/${npmPackageName}`;

export type SprocketDesktopPlatform =
	'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x86_64' | 'linux-arm64';

export interface SprocketDesktopAsset {
	platform: SprocketDesktopPlatform;
	shortLabel: string;
	filename: string;
	url: string;
}

export interface SprocketRelease {
	version: string;
	tagName: string;
	htmlUrl: string;
	assets: SprocketDesktopAsset[];
}

export type SprocketOsFamily = 'mac' | 'windows' | 'linux';

export const OS_LABELS: Record<SprocketOsFamily, string> = {
	mac: 'macOS',
	windows: 'Windows',
	linux: 'Linux'
};

export interface DetectedDesktopTarget {
	platform: SprocketDesktopPlatform | null;
	osFamily: SprocketOsFamily | null;
}

const DESKTOP_ASSET_RULES: {
	platform: SprocketDesktopPlatform;
	match: RegExp;
	shortLabel: string;
}[] = [
	{
		platform: 'mac-arm64',
		match: /^sprocket-desktop-[\d.]+-mac-arm64\.dmg$/i,
		shortLabel: 'Apple Silicon'
	},
	{
		platform: 'mac-x64',
		match: /^sprocket-desktop-[\d.]+-mac-x64\.dmg$/i,
		shortLabel: 'Intel Mac'
	},
	{ platform: 'win-x64', match: /^sprocket-desktop-[\d.]+-win-x64\.exe$/i, shortLabel: 'Windows' },
	{
		platform: 'linux-x86_64',
		match: /^sprocket-desktop-[\d.]+-linux-x86_64\.AppImage$/i,
		shortLabel: 'Linux x64'
	},
	{
		platform: 'linux-arm64',
		match: /^sprocket-desktop-[\d.]+-linux-arm64\.AppImage$/i,
		shortLabel: 'Linux ARM'
	}
];

export function parseSprocketDesktopAssets(
	assets: { name: string; browser_download_url: string }[]
): SprocketDesktopAsset[] {
	return DESKTOP_ASSET_RULES.flatMap(({ platform, match, shortLabel }) => {
		const asset = assets.find(({ name }) => match.test(name));

		return asset
			? [{ platform, shortLabel, filename: asset.name, url: asset.browser_download_url }]
			: [];
	});
}

type NavigatorLike = {
	userAgent: string;
	platform: string;
	maxTouchPoints?: number;
	userAgentData?: {
		platform?: string;
		getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
	};
};

/** Safari reports "Intel Mac OS X" on Apple Silicon, so only Client Hints pick a macOS architecture. */
export function detectDesktopTarget(
	nav: NavigatorLike,
	architectureHint = ''
): DetectedDesktopTarget {
	const ua = nav.userAgent;
	const platform = nav.platform;
	const uaDataPlatform = nav.userAgentData?.platform?.toLowerCase() ?? '';
	const architecture = architectureHint.toLowerCase();

	// Android UAs and navigator.platform often contain "Linux", so mobiles are excluded first.
	const isMobile =
		uaDataPlatform === 'android' ||
		/android/i.test(ua) ||
		/iphone|ipad|ipod/i.test(ua) ||
		(/mac/i.test(platform) && (nav.maxTouchPoints ?? 0) > 1);

	if (isMobile) {
		return { platform: null, osFamily: null };
	}

	const isWindows =
		uaDataPlatform.includes('windows') || /win/i.test(platform) || /windows/i.test(ua);

	if (isWindows) {
		return { platform: 'win-x64', osFamily: 'windows' };
	}

	const isMac =
		uaDataPlatform.includes('mac') || /mac/i.test(platform) || /macintosh|mac os x/i.test(ua);

	if (isMac) {
		const isIntel = architecture === 'x86' || architecture === 'x86_64';
		const isArm = architecture === 'arm' || architecture === 'arm64';

		if (isIntel) {
			return { platform: 'mac-x64', osFamily: 'mac' };
		}

		if (isArm) {
			return { platform: 'mac-arm64', osFamily: 'mac' };
		}

		return { platform: null, osFamily: 'mac' };
	}

	const isLinux = uaDataPlatform.includes('linux') || /linux/i.test(platform) || /linux/i.test(ua);

	if (isLinux) {
		const isArm64 = architecture === 'arm64' || /\baarch64\b/i.test(ua) || /\barm64\b/i.test(ua);

		if (isArm64) {
			return { platform: 'linux-arm64', osFamily: 'linux' };
		}

		const isX64 =
			architecture === 'x86_64' ||
			/\bx86_64\b/i.test(ua) ||
			/\bamd64\b/i.test(ua) ||
			/\bx86_64\b/i.test(platform) ||
			/\bamd64\b/i.test(platform);

		if (isX64) {
			return { platform: 'linux-x86_64', osFamily: 'linux' };
		}

		return { platform: null, osFamily: 'linux' };
	}

	return { platform: null, osFamily: null };
}

export async function detectBrowserDesktopTarget(): Promise<DetectedDesktopTarget> {
	const nav: NavigatorLike = navigator;
	let architecture: string | undefined;

	try {
		architecture = (await nav.userAgentData?.getHighEntropyValues?.(['architecture']))
			?.architecture;
	} catch {}

	return detectDesktopTarget(nav, architecture);
}
