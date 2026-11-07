import type { APIRoute } from 'astro';
import { captureServerException } from '@/lib/analytics/server';
import { pricingAuthServer } from '@/lib/pricing/auth-runtime';
import {
	getPricingSession,
	isSameOriginPost,
	pricingAuthFailure,
	pricingAuthJson,
	PricingAuthError
} from '@/lib/pricing/auth-server';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, url }) => {
	try {
		if (!isSameOriginPost(request)) throw new PricingAuthError('Request not allowed.', 403);
		return pricingAuthJson(await getPricingSession(await pricingAuthServer(), cookies, url));
	} catch (error) {
		const response = pricingAuthFailure(error);
		if (response.status >= 500)
			captureServerException(error, request, { context: 'pricing_session' });
		return response;
	}
};
