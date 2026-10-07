type MarketingOriginEnv = {
	SPROCKET_MARKETING_ORIGIN?: string;
	SPROCKET_BILLING_STAGING_ORIGIN?: string;
	DODO_PAYMENTS_ENVIRONMENT?: string;
};

function httpsOrigin(value: string): string {
	const url = new URL(value);

	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new Error(
			'Billing staging origin must be an explicit HTTPS origin without credentials, path, query, or fragment.'
		);
	}

	return url.origin;
}

export function resolveMarketingPricingUrls(
	env: MarketingOriginEnv,
	tierId: string,
	attemptId?: string
) {
	const allowed = new Set(['https://spikonado.com']);

	if (env.DODO_PAYMENTS_ENVIRONMENT === 'test_mode') {
		allowed.add('http://localhost:4321');
		allowed.add('http://127.0.0.1:4321');
		const staging = env.SPROCKET_BILLING_STAGING_ORIGIN?.trim();

		if (staging) allowed.add(httpsOrigin(staging));
	}

	const configured = env.SPROCKET_MARKETING_ORIGIN?.trim().replace(/\/$/, '');

	if (!configured) throw new Error('SPROCKET_MARKETING_ORIGIN must be configured for billing.');

	if (!allowed.has(configured))
		throw new Error('SPROCKET_MARKETING_ORIGIN is not an approved billing origin.');
	const origin = configured;
	const tier = `&tier=${encodeURIComponent(tierId)}`;
	const attempt = attemptId ? `&attempt=${encodeURIComponent(attemptId)}` : '';

	return {
		return_url: `${origin}/pricing?checkout=return${tier}${attempt}`,
		cancel_url: `${origin}/pricing?checkout=cancel${tier}`
	};
}
