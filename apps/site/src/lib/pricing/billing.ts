import { ConvexHttpClient } from 'convex/browser';
import {
	api,
	type BillingInterval,
	type CheckoutMode,
	type CheckoutStatus,
	type MySubscription,
	type PublicPricingCatalog
} from '@/lib/convex/api';
import type { PricingSession } from './auth-server';

const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const ATTEMPT_KEY = 'spikonado_pricing_attempt';
const CHECKOUT_ORIGINS: Record<CheckoutMode, string> = {
	live: 'https://checkout.dodopayments.com',
	test: 'https://test.checkout.dodopayments.com'
};

export type CheckoutAttempt = { userId: string; attemptId: string; tier: string };

function convexClient(token?: string): ConvexHttpClient {
	const url = import.meta.env.PUBLIC_CONVEX_URL?.trim();
	if (!url) throw new Error('Billing is not configured (missing PUBLIC_CONVEX_URL).');
	const client = new ConvexHttpClient(url, {
		fetch: ((input, init) =>
			fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })) as typeof fetch
	});
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

export function signInForCheckout(tier: string, interval: BillingInterval): void {
	window.location.assign(`/api/pricing/sign-in?${new URLSearchParams({ tier, interval })}`);
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

export function assertCheckoutUrl(url: string, mode: CheckoutMode): void {
	if (new URL(url).origin !== CHECKOUT_ORIGINS[mode]) {
		throw new Error('Checkout returned an invalid link. Contact billing support.');
	}
}

/** Creates a hosted checkout and returns its URL after recording the attempt for recovery. */
export async function startCheckout(tier: string, interval: BillingInterval): Promise<string> {
	const { convex, userId } = await signedIn();
	const result = await convex.action(api.billing.checkout, { tier, interval });
	if (!result.attemptId) {
		throw new Error('Checkout recovery is unavailable. Contact billing support before paying.');
	}
	try {
		sessionStorage.setItem(
			ATTEMPT_KEY,
			JSON.stringify({ userId, attemptId: result.attemptId, tier } satisfies CheckoutAttempt)
		);
	} catch {
		// Without storage the checkout still works; only automatic recovery on return is lost.
	}
	assertCheckoutUrl(result.checkout_url, result.mode);
	return result.checkout_url;
}

export function readCheckoutAttempt(userId: string): CheckoutAttempt | null {
	try {
		const attempt = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) ?? 'null');
		return attempt?.userId === userId &&
			typeof attempt.attemptId === 'string' &&
			typeof attempt.tier === 'string'
			? attempt
			: null;
	} catch {
		return null;
	}
}

export function clearCheckoutAttempt(): void {
	try {
		sessionStorage.removeItem(ATTEMPT_KEY);
	} catch {
		// Storage is unavailable, so there is no attempt to clear.
	}
}

export async function fetchCheckoutStatus(attemptId: string): Promise<CheckoutStatus> {
	const { convex } = await signedIn();
	const status = await convex.action(api.billing.getCheckoutStatus, { attemptId });
	if (status.checkout_url) assertCheckoutUrl(status.checkout_url, status.mode);
	return status;
}

export async function fetchCustomerPortalUrl(): Promise<string> {
	const { convex } = await signedIn();
	return (await convex.action(api.billing.customerPortal, {})).portal_url;
}
