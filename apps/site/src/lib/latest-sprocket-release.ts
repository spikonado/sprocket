import * as z from 'zod/mini';
import { parseSprocketDesktopAssets, type SprocketRelease } from './sprocket-releases';

const gitHubReleaseSchema = z.object({
	tag_name: z.string(),
	html_url: z.string(),
	assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() }))
});

// Throws so a failed fetch fails the build and keeps the last deployment, whose download links work.
export async function fetchLatestSprocketRelease(): Promise<SprocketRelease> {
	const response = await fetch('https://api.github.com/repos/spikonado/sprocket/releases/latest', {
		headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'usesprocket.dev' }
	});

	if (!response.ok) {
		throw new Error(
			`Fetching the latest Sprocket release failed: ${response.status} ${await response.text()}`
		);
	}

	const release = gitHubReleaseSchema.parse(await response.json());
	const assets = parseSprocketDesktopAssets(release.assets);

	if (assets.length === 0) {
		throw new Error(`Sprocket release ${release.tag_name} has no desktop downloads.`);
	}

	return {
		version: release.tag_name.replace(/^v/, ''),
		tagName: release.tag_name,
		htmlUrl: release.html_url,
		assets
	};
}
