export const SITE_NAME = 'Spikonado';
export const SITE_URL = 'https://spikonado.com';
export const TWITTER_HANDLE = '@spikonado';

/** Stable social preview image generated at build time (`src/pages/og.png.ts`). */
export const DEFAULT_OG_IMAGE = '/og.png';

export const DEFAULT_TITLE = 'Spikonado | Your imagination is the limit';
export const DEFAULT_DESCRIPTION =
	'Spikonado helps anyone build apps, robots, devices, and the systems that glue them together.';

export const SPROCKET_DESCRIPTION =
	'Sprocket is the best AI agent for hardware and software. Create schematics, write and test code, use rich web and file context, and buy anything your project needs within approved limits.';

export const ORGANIZATION_SAME_AS = [
	'https://github.com/spikonado',
	'https://x.com/spikonado',
	'https://youtube.com/spikonado',
	'https://instagram.com/spikonado',
	'https://facebook.com/spikonado'
] as const;

export function absoluteUrl(pathnameOrUrl: string, site: URL | string = SITE_URL): string {
	return new URL(pathnameOrUrl, site).href;
}

export function titleWithBrand(pageTitle: string): string {
	if (pageTitle.includes(SITE_NAME)) {
		return pageTitle;
	}
	return `${pageTitle} | ${SITE_NAME}`;
}
