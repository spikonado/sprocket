import type { APIRoute } from 'astro';
import { renderOgImagePng } from '@/lib/og-image';

export const prerender = true;

export const GET: APIRoute = async () => {
	const png = await renderOgImagePng();

	return new Response(new Uint8Array(png), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
};
