import { name as npmPackageName } from '../../../../npm/sprocket/package.json';

export const SPROCKET_NPM_COMMAND = `npx ${npmPackageName}`;
export const SPROCKET_GITHUB_URL = 'https://github.com/spikonado/sprocket';
export const SPROCKET_RELEASES_LATEST_URL = `${SPROCKET_GITHUB_URL}/releases/latest`;
export const SPROCKET_NPM_URL = `https://www.npmjs.com/package/${npmPackageName}`;

/** Stable identifiers matching GitHub desktop asset filenames. */
export type SprocketDesktopPlatform =
	'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x86_64' | 'linux-arm64';

export interface SprocketDesktopAsset {
	platform: SprocketDesktopPlatform;
	label: string;
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

/** Brand mark family for download CTAs. */
export type SprocketOsFamily = 'mac' | 'windows' | 'linux';

export interface DetectedDesktopTarget {
	/** Specific release asset when architecture is known; null if the visitor must choose. */
	platform: SprocketDesktopPlatform | null;
	/** Brand family for icons/labels even when architecture is unknown. */
	osFamily: SprocketOsFamily | null;
	osLabel: string;
}

const DESKTOP_ASSET_RULES: {
	platform: SprocketDesktopPlatform;
	match: RegExp;
	label: string;
	shortLabel: string;
}[] = [
	{
		platform: 'mac-arm64',
		match: /sprocket-desktop-[\d.]+-mac-arm64\.dmg$/i,
		label: 'macOS (Apple Silicon)',
		shortLabel: 'Apple Silicon'
	},
	{
		platform: 'mac-x64',
		match: /sprocket-desktop-[\d.]+-mac-x64\.dmg$/i,
		label: 'macOS (Intel)',
		shortLabel: 'Intel Mac'
	},
	{
		platform: 'win-x64',
		match: /sprocket-desktop-[\d.]+-win-x64\.exe$/i,
		label: 'Windows',
		shortLabel: 'Windows'
	},
	{
		platform: 'linux-x86_64',
		match: /sprocket-desktop-[\d.]+-linux-x86_64\.AppImage$/i,
		label: 'Linux (x64)',
		shortLabel: 'Linux x64'
	},
	{
		platform: 'linux-arm64',
		match: /sprocket-desktop-[\d.]+-linux-arm64\.AppImage$/i,
		label: 'Linux (ARM64)',
		shortLabel: 'Linux ARM'
	}
];

export function parseSprocketDesktopAssets(
	assets: { name: string; browser_download_url: string }[]
): SprocketDesktopAsset[] {
	const parsed: SprocketDesktopAsset[] = [];

	for (const rule of DESKTOP_ASSET_RULES) {
		const asset = assets.find((candidate) => rule.match.test(candidate.name));

		if (!asset) {
			continue;
		}

		parsed.push({
			platform: rule.platform,
			label: rule.label,
			shortLabel: rule.shortLabel,
			filename: asset.name,
			url: asset.browser_download_url
		});
	}

	return parsed;
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

/**
 * Best-effort desktop target from the browser environment.
 * Mobile OSes (Android/iOS) are not desktop download targets.
 * macOS architecture is only selected from Client Hints — Safari still reports
 * "Intel Mac OS X" on Apple Silicon, so guessing from the UA is unsafe.
 */
export function detectDesktopTarget(
	nav: NavigatorLike,
	architectureHint = ''
): DetectedDesktopTarget {
	const ua = nav.userAgent;
	const platform = nav.platform;
	const uaDataPlatform = nav.userAgentData?.platform?.toLowerCase() ?? '';
	const architecture = architectureHint.toLowerCase();

	// Android UAs / navigator.platform often contain "Linux" — exclude mobiles first.
	const isMobile =
		uaDataPlatform === 'android' ||
		/android/i.test(ua) ||
		/iphone|ipad|ipod/i.test(ua) ||
		(/mac/i.test(platform) && (nav.maxTouchPoints ?? 0) > 1);

	if (isMobile) {
		return { platform: null, osFamily: null, osLabel: 'your device' };
	}

	const isWindows =
		uaDataPlatform.includes('windows') || /win/i.test(platform) || /windows/i.test(ua);

	if (isWindows) {
		return { platform: 'win-x64', osFamily: 'windows', osLabel: 'Windows' };
	}

	const isMac =
		uaDataPlatform.includes('mac') || /mac/i.test(platform) || /macintosh|mac os x/i.test(ua);

	if (isMac) {
		const isIntel = architecture === 'x86' || architecture === 'x86_64';
		const isArm = architecture === 'arm' || architecture === 'arm64';

		if (isIntel) {
			return { platform: 'mac-x64', osFamily: 'mac', osLabel: 'macOS' };
		}

		if (isArm) {
			return { platform: 'mac-arm64', osFamily: 'mac', osLabel: 'macOS' };
		}

		// Architecture unknown: show macOS CTA but do not auto-pick a DMG.
		return { platform: null, osFamily: 'mac', osLabel: 'macOS' };
	}

	const isLinux = uaDataPlatform.includes('linux') || /linux/i.test(platform) || /linux/i.test(ua);

	if (isLinux) {
		// Only auto-pick when the arch is positively known. ARMv7 / unknown must not
		// fall through to the x86_64 AppImage (unusable), or be treated as ARM64.
		const isArm64 = architecture === 'arm64' || /\baarch64\b/i.test(ua) || /\barm64\b/i.test(ua);

		if (isArm64) {
			return { platform: 'linux-arm64', osFamily: 'linux', osLabel: 'Linux' };
		}

		const isX64 =
			architecture === 'x86_64' ||
			/\bx86_64\b/i.test(ua) ||
			/\bamd64\b/i.test(ua) ||
			/\bx86_64\b/i.test(platform) ||
			/\bamd64\b/i.test(platform);

		if (isX64) {
			return { platform: 'linux-x86_64', osFamily: 'linux', osLabel: 'Linux' };
		}

		return { platform: null, osFamily: 'linux', osLabel: 'Linux' };
	}

	return { platform: null, osFamily: null, osLabel: 'your OS' };
}

export async function detectDesktopTargetAsync(
	nav: NavigatorLike = navigator
): Promise<DetectedDesktopTarget> {
	let architecture: string | undefined;

	try {
		architecture = (await nav.userAgentData?.getHighEntropyValues?.(['architecture']))
			?.architecture;
	} catch {
		// Without Client Hints the architecture stays unknown.
	}

	return detectDesktopTarget(nav, architecture);
}
