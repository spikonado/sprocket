import { env } from '@convex/_generated/server';

type PravaConfig = {
	baseUrl: string;
	secretKey: string;
};

export type PravaMandate = {
	id?: string;
	status?: string;
	recurringFrequency?: string;
	merchantScope?: string;
	remaining?: string | null;
	approvedAmount?: string;
	currency?: string;
	merchantName?: string | null;
	validUntil?: string | null;
	renewsAt?: string | null;
};

function pravaConfig(): PravaConfig {
	const secretKey = env.PRAVA_SECRET_KEY?.trim();
	if (!secretKey) {
		throw new Error('PRAVA_SECRET_KEY is not configured.');
	}
	return {
		baseUrl: env.PRAVA_BACKEND_URL,
		secretKey
	};
}

export async function pravaRequest<T>(path: string, init?: RequestInit): Promise<T> {
	const { baseUrl, secretKey } = pravaConfig();
	const headers = new Headers(init?.headers);
	headers.set('Authorization', `Bearer ${secretKey}`);
	if (init?.body) headers.set('Content-Type', 'application/json');
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers
	});
	if (!response.ok) {
		const details = await response.text();
		let message = details;
		try {
			// SAFETY: Prava errors share one documented envelope
			// ({error:{code,message,details}}); both fields are optional-checked
			// before use and anything else keeps the raw body as the message.
			const parsed = JSON.parse(details) as { error?: { code?: string; message?: string } };
			if (parsed.error?.code || parsed.error?.message) {
				message = [parsed.error.code, parsed.error.message].filter(Boolean).join(' - ');
			}
		} catch {
			// Not JSON; surface the raw body.
		}
		throw new Error(`Prava request failed (${response.status})${message ? `: ${message}` : '.'}`);
	}
	const body = await response.text();
	// SAFETY: unchecked decode of the trusted Prava API response into its documented contract T.
	return (body ? JSON.parse(body) : undefined) as T;
}

/** A first-time customer has no Prava customer record yet, so listing their
 * mandates 404s with CUSTOMER_NOT_FOUND; treat that as "no mandates yet"
 * rather than an error. */
function isPravaCustomerNotFound(error: Error): boolean {
	return error.message.includes('CUSTOMER_NOT_FOUND');
}

/** List a customer's mandates from Prava, treating a first-time customer's
 * CUSTOMER_NOT_FOUND 404 as an empty list rather than an error. */
export async function listPravaMandates(
	userId: string,
	standingOnly: boolean
): Promise<PravaMandate[]> {
	try {
		const list = await pravaRequest<{ mandates?: PravaMandate[] }>(
			`/v1/mandates?customer_id=${encodeURIComponent(userId)}${standingOnly ? '&standing_only=true' : ''}`
		);
		return list.mandates ?? [];
	} catch (error) {
		if (error instanceof Error && isPravaCustomerNotFound(error)) {
			return [];
		}
		throw error;
	}
}
