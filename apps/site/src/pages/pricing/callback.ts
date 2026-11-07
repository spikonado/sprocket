import type { APIRoute } from 'astro';
import { captureServerException } from '@/lib/analytics/server';
import { pricingAuthServer } from '@/lib/pricing/auth-runtime';
import { completePricingSignIn } from '@/lib/pricing/auth-server';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
	const location = await pricingAuthServer()
		.then((server) => completePricingSignIn(server, cookies, url))
		.catch((error: unknown) => {
			captureServerException(error, request, { context: 'pricing_sign_in_callback' });
			return '/pricing?sign_in=failed';
		});
	return new Response(null, {
		status: 303,
		headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
	});
};
