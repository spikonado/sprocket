import { api } from '@convex/_generated/api';
import { PUBLIC_CONVEX_URL } from 'astro:env/client';
import type { ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import * as z from 'zod/mini';
import { convexClientWithTimeout } from '@/lib/convex-client';
import type { PricingSession } from './auth-server';
import type { Purchase } from './catalog';
import type { CheckoutStatus, MySubscription, PublicPricingCatalog } from './convex-types';

const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const ATTEMPT_KEY = 'sprocket_pricing_attempt';

const checkoutAttemptSchema = z.object({
	userId: z.string(),
	attemptId: z.string(),
	purchase: z.union([
		z.object({ tier: z.string(), interval: z.enum(['monthly', 'annual']) }),
		z.object({ pack: z.string() })
	])
});

export type CheckoutAttempt = z.infer<typeof checkoutAttemptSchema>;

function convexClient(token?: string): ConvexHttpClient {
	const url = PUBLIC_CONVEX_URL?.trim();

	if (!url) throw new Error('Billing is not configured (missing PUBLIC_CONVEX_URL).');

	const client = convexClientWithTimeout(url, REQUEST_TIMEOUT_MS);

	if (token) client.setAuth(token);

	return client;
}

export async function fetchPricingCatalog(): Promise<PublicPricingCatalog> {
	return convexClient().action(api.pricing.getPublicCatalog, {});
}

async function postPricingAuth<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		cache: 'no-store',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});

	const body = await response.json();

	if (!response.ok) throw new Error(body.error ?? 'Sign-in is temporarily unavailable.');

	return body;
}

let session: Promise<PricingSession> | null = null;

export function loadPricingSession({ reload = false } = {}): Promise<PricingSession> {
	if (reload || !session) {
		session = postPricingAuth<PricingSession>('/api/pricing/session').catch((error) => {
			session = null;
			throw error;
		});
	}

	return session;
}

async function signedIn(): Promise<{ convex: ConvexHttpClient; userId: string }> {
	let current = await loadPricingSession();

	if (current.expiresAt !== null && current.expiresAt < Date.now() + TOKEN_REFRESH_MARGIN_MS) {
		current = await loadPricingSession({ reload: true });
	}

	if (!current.user || !current.accessToken) throw new Error('Sign in to continue.');

	return { convex: convexClient(current.accessToken), userId: current.user.id };
}

export function signInForCheckout(purchase: Purchase): void {
	window.location.assign(`/api/pricing/sign-in?${new URLSearchParams(purchase)}`);
}

export async function signOutOfPricing(): Promise<void> {
	clearCheckoutAttempt();
	session = null;

	const { logoutUrl } = await postPricingAuth<{ logoutUrl: string | null }>(
		'/api/pricing/sign-out'
	);

	if (logoutUrl) window.location.assign(logoutUrl);
}

export async function fetchMySubscription(): Promise<MySubscription> {
	const { convex } = await signedIn();

	return convex.query(api.billing.getMySubscription, {});
}

export async function startCheckout(purchase: Purchase): Promise<string> {
	const { convex, userId } = await signedIn();

	const result = await ('pack' in purchase
		? convex.action(api.billing.buyCredits, { productId: purchase.pack })
		: convex.action(api.billing.checkout, purchase));

	try {
		sessionStorage.setItem(
			ATTEMPT_KEY,
			JSON.stringify({ userId, attemptId: result.attemptId, purchase } satisfies CheckoutAttempt)
		);
	} catch {}

	return result.checkout_url;
}

export function readCheckoutAttempt(userId: string): CheckoutAttempt | null {
	try {
		const attempt = checkoutAttemptSchema.safeParse(
			JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) ?? 'null')
		).data;

		return attempt?.userId === userId ? attempt : null;
	} catch {
		return null;
	}
}

export function clearCheckoutAttempt(): void {
	try {
		sessionStorage.removeItem(ATTEMPT_KEY);
	} catch {}
}

export async function fetchCheckoutStatus(attemptId: string): Promise<CheckoutStatus> {
	const { convex } = await signedIn();

	return convex.action(api.billing.getCheckoutStatus, { attemptId });
}

export async function fetchCustomerPortalUrl(): Promise<string> {
	const { convex } = await signedIn();

	return (await convex.action(api.billing.customerPortal, {})).portal_url;
}

export function billingRefusalMessage(cause: unknown): string | null {
	return cause instanceof ConvexError ? (z.string().safeParse(cause.data).data ?? null) : null;
}
