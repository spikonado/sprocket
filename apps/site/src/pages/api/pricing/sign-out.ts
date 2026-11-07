import type { APIRoute } from 'astro';
import { pricingAuthServer } from '@/lib/pricing/auth-runtime';
import {
	isSameOriginPost,
	pricingAuthJson,
	pricingLogoutUrl,
	takePricingSession
} from '@/lib/pricing/auth-server';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, url }) => {
	if (!isSameOriginPost(request)) return pricingAuthJson({ error: 'Request not allowed.' }, 403);
	const sealedSession = takePricingSession(cookies, url);
	// Local sign-out still succeeds when the billing backend or WorkOS is unavailable.
	const logoutUrl = sealedSession
		? await pricingAuthServer()
				.then((server) => pricingLogoutUrl(server, sealedSession, url))
				.catch(() => null)
		: null;
	return pricingAuthJson({ logoutUrl });
};
