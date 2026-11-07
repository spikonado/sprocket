import type { APIRoute } from 'astro';
import { renderOgImagePng } from '@/lib/og-image';

export const GET: APIRoute = async () => {
	return new Response(new Uint8Array(await renderOgImagePng()), {
		headers: { 'Content-Type': 'image/png' }
	});
};
