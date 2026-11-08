import type { BillingInterval, DodoPrice, PublicPricingCatalog } from './convex-types';

export type PlanCard = {
	id: string;
	name: string;
	description: string;
	highlighted: boolean;
	primaryCta: boolean;
	previousPlanName: string | null;
	features: PlanFeature[];
	isFree: boolean;
	prices: Record<BillingInterval, string | null>;
	annualPerMonth: string | null;
	annualDiscountPercent: number;
};

export type PlanFeature = { label: string; href?: string };

export type CreditPackCard = {
	productId: string;
	price: string;
	usage: string;
	expiresAfter: string;
};

export type Purchase = { tier: string; interval: BillingInterval } | { pack: string };

function usd(dollars: number): string {
	return formatPrice({ amountMinor: Math.round(dollars * 100), currency: 'USD' });
}

function duration({ count, unit }: PublicPricingCatalog['creditPacks'][number]['expiresAfter']) {
	return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function planFeatures(plan: PublicPricingCatalog['plans'][number], isFree: boolean): PlanFeature[] {
	return [
		{ label: `${usd(plan.monthlyUsageDollars)} of AI usage each month` },
		{ label: 'Bring your own API keys and subscriptions' },
		{ label: `${isFree ? 'Limited' : 'Unlimited'} context from the web` },
		{ label: 'Fair source', href: 'https://fsl.software/' },
		{ label: 'Self-host anytime' },
		...plan.features.map((feature) => ({ label: feature.trim() }))
	].filter(
		(feature, index, all) =>
			feature.label && all.findIndex(({ label }) => label === feature.label) === index
	);
}

export const pricingFaqs = [
	{
		question: 'Are there other limits on AI usage?',
		answer:
			"No. Your plan's monthly AI usage is the only limit, with no session, daily, or weekly caps on top of it. To keep responses reliable, Sprocket switches to backup providers when one goes down. You can also bring your own API keys and subscriptions on every plan."
	},
	{
		question: 'Which AI models can I use?',
		answer:
			"Sprocket offers a focused set of models that we've assessed as the best value for your time and money, rather than every model available. We review the list with every new model release. To request a model we don't include, email its name and why you think it would be a good fit to aarav@spikonado.com, and we'll look into it."
	},
	{
		question: 'How does using my own API keys or subscriptions work?',
		answer:
			"Add API keys from providers like OpenAI and Anthropic, or connect subscriptions like ChatGPT (Codex), Claude Code, GitHub Copilot, and OpenCode. Compatible models then run on your own plan and don't use your Sprocket AI usage."
	},
	{
		question: 'What are my payment options?',
		answer:
			'Credit and debit cards, UPI, Apple Pay, Google Pay, Cash App Pay, Klarna, RuPay, Satispay, Kakao Pay, Naver Pay, and Pix. Checkout shows the options available in your country and currency.'
	}
];

export function isBillingInterval(value: unknown): value is BillingInterval {
	return value === 'monthly' || value === 'annual';
}

export function readPurchase(params: URLSearchParams): Purchase | null {
	const pack = params.get('pack');
	const tier = params.get('tier');
	const interval = params.get('interval');

	if (pack) return { pack };

	return tier && isBillingInterval(interval) ? { tier, interval } : null;
}

// Dodo amounts are in ISO 4217 minor units, which Intl's currency fraction digits match.
export function formatPrice({ amountMinor, currency }: DodoPrice): string {
	const digits =
		new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
			.maximumFractionDigits ?? 2;

	const amount = amountMinor / 10 ** digits;

	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency,
		minimumFractionDigits: Number.isInteger(amount) ? 0 : digits,
		maximumFractionDigits: digits
	}).format(amount);
}

function annualDiscountPercent(monthly: DodoPrice | null, annual: DodoPrice | null): number {
	if (!monthly || !annual || monthly.currency !== annual.currency || monthly.amountMinor <= 0)
		return 0;
	const yearOfMonthly = monthly.amountMinor * 12;

	return Math.max(0, Math.round(((yearOfMonthly - annual.amountMinor) / yearOfMonthly) * 100));
}

export function buildPlanCards(catalog: PublicPricingCatalog): PlanCard[] {
	const free = formatPrice({ amountMinor: 0, currency: 'USD' });
	let previous: { name: string; labels: Set<string> } | null = null;

	return catalog.plans.map((plan) => {
		const isFree = plan.id === 'free';
		const { monthly, annual } = plan.prices;
		const features = planFeatures(plan, isFree);
		const inherited = previous;
		previous = { name: plan.label, labels: new Set(features.map(({ label }) => label)) };

		return {
			id: plan.id,
			name: plan.label,
			description: plan.description?.trim() ?? '',
			highlighted: plan.highlighted,
			primaryCta: plan.highlighted || isFree,
			isFree,
			previousPlanName: inherited?.name ?? null,
			features: inherited ? features.filter(({ label }) => !inherited.labels.has(label)) : features,
			prices: {
				monthly: isFree ? free : monthly && formatPrice(monthly),
				annual: isFree ? free : annual && formatPrice(annual)
			},
			annualPerMonth: isFree
				? free
				: annual &&
					formatPrice({
						amountMinor: Math.round(annual.amountMinor / 12),
						currency: annual.currency
					}),
			annualDiscountPercent: annualDiscountPercent(monthly, annual)
		};
	});
}

/** Packs without a synced price can't be bought yet. */
export function buildCreditPackCards(catalog: PublicPricingCatalog): CreditPackCard[] {
	return catalog.creditPacks.flatMap(({ productId, usageDollars, expiresAfter, price }) =>
		price
			? [
					{
						productId,
						price: formatPrice(price),
						usage: usd(usageDollars),
						expiresAfter: duration(expiresAfter)
					}
				]
			: []
	);
}
