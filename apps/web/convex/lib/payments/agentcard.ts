import { z } from 'zod';
import { env } from '@convex/_generated/server';
import { constantTimeEqual } from '@convex/lib/auth';
import type { PurchaseStatus } from '@convex/lib/validators';

const AGENTCARD_API = 'https://api.agentcard.sh';

export type AgentcardCredentials = { clientId: string; clientSecret: string };

export function agentcardCredentials(): AgentcardCredentials {
	const clientId = env.AGENTCARD_CLIENT_ID?.trim();
	const clientSecret = env.AGENTCARD_CLIENT_SECRET?.trim();

	if (!clientId || !clientSecret) {
		throw new Error('Agentcard is not configured on this deployment.');
	}

	return { clientId, clientSecret };
}

export class AgentcardError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
		message: string
	) {
		super(message);
	}
}

const errorEnvelope = z.object({
	error: z.union([
		z.string().transform((code) => ({ code, message: undefined })),
		z.object({ code: z.string().optional(), message: z.string().optional() })
	])
});

function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
	try {
		const parsed = schema.safeParse(JSON.parse(text));

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function readError(response: Response): Promise<AgentcardError> {
	const text = await response.text();
	const error = parseJson(errorEnvelope, text)?.error;
	const code = error?.code;
	const message = error?.message ?? text;

	return new AgentcardError(
		response.status,
		code,
		`Agentcard request failed (${response.status})${code ? ` ${code}` : ''}: ${message}`
	);
}

export async function exchangeAgentcardToken(
	credentials: AgentcardCredentials
): Promise<{ accessToken: string; expiresAt: number }> {
	const response = await fetch(`${AGENTCARD_API}/api/v2/oauth/token`, {
		method: 'POST',
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret
		})
	});

	if (!response.ok) throw await readError(response);

	// SAFETY: documented OAuth client-credentials response.
	const body = (await response.json()) as { access_token: string; expires_in: number };

	return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

export async function agentcardRequest<T>(
	accessToken: string,
	path: string,
	init?: { method?: string; body?: unknown }
): Promise<T> {
	const headers = new Headers({ Authorization: `Bearer ${accessToken}` });

	if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

	const response = await fetch(`${AGENTCARD_API}${path}`, {
		method: init?.method ?? 'GET',
		headers,
		body: init?.body === undefined ? undefined : JSON.stringify(init.body)
	});

	if (!response.ok) throw await readError(response);

	// SAFETY: unchecked decode of the trusted Agentcard response into its documented contract T.
	return (await response.json()) as T;
}

export type Recognizer = { psp: string; hosts: string[]; match: string };

export function recognizes(recognizer: Recognizer, url: URL): boolean {
	return (
		recognizer.hosts.some((host) => new RegExp(host).test(url.hostname)) &&
		new RegExp(`^(?:${recognizer.match})$`).test(`${url.hostname}${url.pathname}`)
	);
}

export function isCheckoutOrigin(origin: string): boolean {
	return /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin) && !origin.endsWith(':443');
}

export type VaultSession = {
	status: 'pending' | 'linked' | 'expired';
	user_id: string | null;
	external_user_id?: string | null;
};

export type AgentcardAuthorization = {
	id: string;
	status: 'awaiting_approval' | 'approved' | 'submitted_on_device' | 'declined' | 'expired';
	amount: number | null;
	currency: string | null;
	approvalUrl?: string;
	poll_interval_ms?: number;
	reason?: string;
	settlement?: { status?: string } | null;
	response?: { status: number; headers: Record<string, string>; body: string };
};

export async function verifyAgentcardSignature(
	secret: string,
	header: string,
	body: string,
	now = Date.now()
): Promise<boolean> {
	const parts = new Map(
		header.split(',').map((part) => {
			const separator = part.indexOf('=');

			return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const;
		})
	);

	const timestamp = Number(parts.get('t'));
	const signature = parts.get('v1');

	if (!signature || !Number.isFinite(timestamp)) return false;

	if (Math.abs(now / 1000 - timestamp) > 5 * 60) return false;

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const digest = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${parts.get('t')}.${body}`)
	);

	const expected = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

	return constantTimeEqual(expected, signature);
}

export type AgentcardWebhook =
	| { kind: 'session_linked'; vaultSessionId: string }
	| { kind: 'authorization'; authorizationId: string; status: PurchaseStatus };

const webhookStatuses = new Map<string, PurchaseStatus>([
	['checkout_authorization.approved', 'approved'],
	['checkout_authorization.submitted', 'submitted_on_device'],
	['checkout_authorization.declined', 'declined'],
	['checkout_authorization.expired', 'expired'],
	['checkout_authorization.settled', 'settled']
]);

const webhookEvent = z.object({
	type: z.string(),
	data: z
		.object({
			id: z.string().optional(),
			authorization_id: z.string().optional(),
			vault_session_id: z.string().optional()
		})
		.default({})
});

/** The update a verified webhook body asks for, or null for events Sprocket ignores. */
export function parseAgentcardWebhook(body: string): AgentcardWebhook | null {
	const event = parseJson(webhookEvent, body);

	if (!event) return null;

	const { type, data } = event;

	if (type === 'vault.session_linked') {
		return data.vault_session_id
			? { kind: 'session_linked', vaultSessionId: data.vault_session_id }
			: null;
	}

	const status = webhookStatuses.get(type);
	const authorizationId = data.id ?? data.authorization_id;

	return status && authorizationId ? { kind: 'authorization', authorizationId, status } : null;
}
