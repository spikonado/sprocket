import { getSecret } from 'astro:env/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/lib/convex/api';
import { createPricingAuthServer, PricingAuthError, type PricingAuthServer } from './auth-server';

let serverPromise: Promise<PricingAuthServer> | null = null;

export function pricingAuthServer(): Promise<PricingAuthServer> {
	serverPromise ??= (async () => {
		const convexUrl = import.meta.env.PUBLIC_CONVEX_URL?.trim();
		if (!convexUrl)
			throw new PricingAuthError('Billing is not configured (missing PUBLIC_CONVEX_URL).');
		const bootstrap = await new ConvexHttpClient(convexUrl, {
			fetch: ((input, init) =>
				fetch(input, { ...init, signal: AbortSignal.timeout(8_000) })) as typeof fetch
		}).query(api.authBootstrap.getClientConfig, {});
		return createPricingAuthServer(
			getSecret('WORKOS_API_KEY'),
			getSecret('WORKOS_COOKIE_PASSWORD'),
			bootstrap.workosClientId
		);
	})().catch((error) => {
		serverPromise = null;
		throw error;
	});
	return serverPromise;
}
