type MarketingOriginEnv = {
	SPROCKET_MARKETING_ORIGIN?: string;
	DODO_PAYMENTS_ENVIRONMENT?: string;
};

export function resolveMarketingPricingUrls(env: MarketingOriginEnv = process.env) {
	const configured = env.SPROCKET_MARKETING_ORIGIN?.trim().replace(/\/$/, '');
	const allowed = new Set(['https://spikonado.com']);
	if (env.DODO_PAYMENTS_ENVIRONMENT !== 'live_mode') {
		allowed.add('http://localhost:4321');
		allowed.add('http://127.0.0.1:4321');
	}
	const origin = configured && allowed.has(configured) ? configured : 'https://spikonado.com';
	return {
		return_url: `${origin}/pricing?checkout=return`,
		cancel_url: `${origin}/pricing?checkout=cancel`
	};
}
