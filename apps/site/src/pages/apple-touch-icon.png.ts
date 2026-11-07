import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRoute } from 'astro';
import sharp from 'sharp';

export const prerender = true;

const ICON_SIZE = 180;
const LOGO_SIZE = 144;
// iOS fills transparent touch icons with black, so the logo sits on the site background.
const BACKGROUND = '#f0f4eb';

export const GET: APIRoute = async () => {
	const svg = await readFile(join(process.cwd(), 'src/assets/logo.svg'));
	const logo = await sharp(svg).resize(LOGO_SIZE, LOGO_SIZE).png().toBuffer();
	const png = await sharp({
		create: { width: ICON_SIZE, height: ICON_SIZE, channels: 4, background: BACKGROUND }
	})
		.composite([{ input: logo, gravity: 'center' }])
		.png()
		.toBuffer();

	return new Response(new Uint8Array(png), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=86400'
		}
	});
};
