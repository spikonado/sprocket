import * as z from 'zod/mini';
import { parseSprocketDesktopAssets, type SprocketRelease } from './sprocket-releases';

const gitHubReleaseSchema = z.object({
	tag_name: z.string(),
	html_url: z.string(),
	assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() }))
});

export async function fetchLatestSprocketRelease(): Promise<SprocketRelease | null> {
	try {
		const response = await fetch(
			'https://api.github.com/repos/spikonado/sprocket/releases/latest',
			{
				headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'usesprocket.dev' }
			}
		);

		if (!response.ok) {
			return null;
		}

		const release = gitHubReleaseSchema.safeParse(await response.json()).data;
		const assets = release ? parseSprocketDesktopAssets(release.assets) : [];

		if (!release || assets.length === 0) {
			return null;
		}

		return {
			version: release.tag_name.replace(/^v/, ''),
			tagName: release.tag_name,
			htmlUrl: release.html_url,
			assets
		};
	} catch {
		return null;
	}
}
