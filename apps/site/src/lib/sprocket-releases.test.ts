import { describe, expect, test } from 'bun:test';
import {
	detectDesktopTarget,
	osFamilyForPlatform,
	otherDesktopAssets,
	parseSprocketDesktopAssets,
	pickDesktopAsset
} from './sprocket-releases.ts';

const sampleAssets = [
	{
		name: 'sprocket-desktop-0.2.4-linux-arm64.AppImage',
		browser_download_url:
			'https://github.com/spikonado/sprocket/releases/download/v0.2.4/sprocket-desktop-0.2.4-linux-arm64.AppImage'
	},
	{
		name: 'sprocket-desktop-0.2.4-linux-x86_64.AppImage',
		browser_download_url:
			'https://github.com/spikonado/sprocket/releases/download/v0.2.4/sprocket-desktop-0.2.4-linux-x86_64.AppImage'
	},
	{
		name: 'sprocket-desktop-0.2.4-mac-arm64.dmg',
		browser_download_url:
			'https://github.com/spikonado/sprocket/releases/download/v0.2.4/sprocket-desktop-0.2.4-mac-arm64.dmg'
	},
	{
		name: 'sprocket-desktop-0.2.4-mac-x64.dmg',
		browser_download_url:
			'https://github.com/spikonado/sprocket/releases/download/v0.2.4/sprocket-desktop-0.2.4-mac-x64.dmg'
	},
	{
		name: 'sprocket-desktop-0.2.4-win-x64.exe',
		browser_download_url:
			'https://github.com/spikonado/sprocket/releases/download/v0.2.4/sprocket-desktop-0.2.4-win-x64.exe'
	},
	{
		name: 'SHA256SUMS',
		browser_download_url:
			'https://github.com/spikonado/sprocket/releases/download/v0.2.4/SHA256SUMS'
	}
];

describe('parseSprocketDesktopAssets', () => {
	test('maps known desktop assets and ignores checksums', () => {
		const assets = parseSprocketDesktopAssets(sampleAssets);
		expect(assets.map((asset) => asset.platform)).toEqual([
			'mac-arm64',
			'mac-x64',
			'win-x64',
			'linux-x86_64',
			'linux-arm64'
		]);
		expect(assets.find((asset) => asset.platform === 'mac-arm64')?.url).toContain('mac-arm64.dmg');
	});
});

describe('pickDesktopAsset / otherDesktopAssets', () => {
	const assets = parseSprocketDesktopAssets(sampleAssets);

	test('picks the matching platform asset', () => {
		expect(pickDesktopAsset(assets, 'win-x64')?.filename).toBe(
			'sprocket-desktop-0.2.4-win-x64.exe'
		);
	});

	test('lists every other platform when one is selected', () => {
		expect(otherDesktopAssets(assets, 'mac-arm64').map((asset) => asset.platform)).toEqual([
			'mac-x64',
			'win-x64',
			'linux-x86_64',
			'linux-arm64'
		]);
	});
});

describe('detectDesktopTarget', () => {
	test('detects Windows', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
				platform: 'Win32'
			})
		).toEqual({ platform: 'win-x64', osFamily: 'windows', osLabel: 'Windows' });
	});

	test('does not guess Mac architecture without Client Hints', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
				platform: 'MacIntel'
			})
		).toEqual({ platform: null, osFamily: 'mac', osLabel: 'macOS' });
	});

	test('uses architecture hint for Intel Mac', () => {
		expect(
			detectDesktopTarget(
				{
					userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
					platform: 'MacIntel'
				},
				'x86'
			)
		).toEqual({ platform: 'mac-x64', osFamily: 'mac', osLabel: 'macOS' });
	});

	test('uses architecture hint for Apple Silicon Mac', () => {
		expect(
			detectDesktopTarget(
				{
					userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
					platform: 'MacIntel'
				},
				'arm'
			)
		).toEqual({ platform: 'mac-arm64', osFamily: 'mac', osLabel: 'macOS' });
	});

	test('detects Linux x64 when the UA/platform identify x86_64', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
				platform: 'Linux x86_64'
			})
		).toEqual({ platform: 'linux-x86_64', osFamily: 'linux', osLabel: 'Linux' });
	});

	test('detects Linux ARM64 from UA or Client Hints', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux aarch64)',
				platform: 'Linux aarch64'
			})
		).toEqual({ platform: 'linux-arm64', osFamily: 'linux', osLabel: 'Linux' });
		expect(
			detectDesktopTarget(
				{
					userAgent: 'Mozilla/5.0 (X11; Linux)',
					platform: 'Linux'
				},
				'arm64'
			)
		).toEqual({ platform: 'linux-arm64', osFamily: 'linux', osLabel: 'Linux' });
	});

	test('does not auto-pick an AppImage for Linux ARMv7 or unknown arch', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (X11; Linux armv7l)',
				platform: 'Linux armv7l'
			})
		).toEqual({ platform: null, osFamily: 'linux', osLabel: 'Linux' });
		expect(
			detectDesktopTarget(
				{
					userAgent: 'Mozilla/5.0 (X11; Linux armv7l)',
					platform: 'Linux armv7l'
				},
				'arm'
			)
		).toEqual({ platform: null, osFamily: 'linux', osLabel: 'Linux' });
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (X11; Linux)',
				platform: 'Linux'
			})
		).toEqual({ platform: null, osFamily: 'linux', osLabel: 'Linux' });
	});

	test('skips iOS devices', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
				platform: 'iPhone'
			})
		).toEqual({ platform: null, osFamily: null, osLabel: 'your device' });
	});

	test('skips Android even when platform reports Linux', () => {
		expect(
			detectDesktopTarget({
				userAgent:
					'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
				platform: 'Linux armv8l'
			})
		).toEqual({ platform: null, osFamily: null, osLabel: 'your device' });
	});

	test('skips Android Client Hints platform', () => {
		expect(
			detectDesktopTarget({
				userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
				platform: 'Linux armv8l',
				userAgentData: { platform: 'Android' }
			})
		).toEqual({ platform: null, osFamily: null, osLabel: 'your device' });
	});
});

describe('osFamilyForPlatform', () => {
	test('maps platforms to brand families', () => {
		expect(osFamilyForPlatform('mac-arm64')).toBe('mac');
		expect(osFamilyForPlatform('mac-x64')).toBe('mac');
		expect(osFamilyForPlatform('win-x64')).toBe('windows');
		expect(osFamilyForPlatform('linux-x86_64')).toBe('linux');
		expect(osFamilyForPlatform(null)).toBeNull();
	});
});
