import { z } from 'zod';
import { ConvexError } from 'convex/values';
import { bytesToBase64Url } from '@convex/lib/gatewayToken';
import { providerFetch } from '@convex/lib/workosVault';

// The key's own `token_uri` is ignored so a pasted key can't redirect the signed assertion.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const ASSERTION_TTL_S = 3600;

const serviceAccountSchema = z.object({
	type: z.literal('service_account'),
	project_id: z.string().min(1),
	client_email: z.string().min(1),
	private_key: z.string().includes('-----BEGIN PRIVATE KEY-----')
});

export type GoogleServiceAccount = z.infer<typeof serviceAccountSchema>;

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().positive()
});

export function parseServiceAccount(text: string): GoogleServiceAccount | null {
	try {
		return serviceAccountSchema.parse(JSON.parse(text));
	} catch {
		return null;
	}
}

function base64UrlJson(value: Record<string, string | number>) {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedAssertion(account: GoogleServiceAccount, nowS: number) {
	const der = Uint8Array.from(
		atob(account.private_key.replace(/-----[A-Z ]+-----|\s/g, '')),
		(char) => char.charCodeAt(0)
	);

	const key = await crypto.subtle.importKey(
		'pkcs8',
		der,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);

	const unsigned = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
		iss: account.client_email,
		scope: SCOPE,
		aud: TOKEN_URL,
		iat: nowS,
		exp: nowS + ASSERTION_TTL_S
	})}`;

	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		new TextEncoder().encode(unsigned)
	);

	return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** `null` when Google rejects the key. */
export async function mintAccessToken(
	account: GoogleServiceAccount
): Promise<{ token: string; expiresAt: number } | null> {
	const now = Date.now();

	const assertion = await signedAssertion(account, Math.floor(now / 1000)).catch(() => {
		throw new ConvexError('The private key in this service account key is invalid.');
	});

	const unreachable = new ConvexError(
		'Google could not issue a Vertex AI access token. Try again in a moment.'
	);

	const response = await providerFetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion
		})
	}).catch(() => {
		throw unreachable;
	});

	if (response.status === 400 || response.status === 401) return null;

	if (!response.ok) throw unreachable;
	const { access_token, expires_in } = tokenResponseSchema.parse(await response.json());

	return { token: access_token, expiresAt: now + expires_in * 1000 };
}
