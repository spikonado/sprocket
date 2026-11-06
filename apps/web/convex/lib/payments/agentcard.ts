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

const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });

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

	const body = tokenResponse.parse(await response.json());

	return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

export async function agentcardRequest<T>(
	accessToken: string,
	path: string,
	schema: z.ZodType<T>,
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

	return schema.parse(await response.json());
}

export const recognizers = z.array(
	z.object({ psp: z.string(), hosts: z.array(z.string()), match: z.string() })
);

export type Recognizer = z.infer<typeof recognizers>[number];

export function recognizes(recognizer: Recognizer, url: URL): boolean {
	return (
		recognizer.hosts.some((host) => new RegExp(host).test(url.hostname)) &&
		new RegExp(`^(?:${recognizer.match})$`).test(`${url.hostname}${url.pathname}`)
	);
}

export function isCheckoutOrigin(origin: string): boolean {
	return /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin) && !origin.endsWith(':443');
}

export const vaultSession = z.object({
	status: z.enum(['pending', 'linked', 'expired']),
	user_id: z.string().nullable(),
	external_user_id: z.string().nullish()
});

export const createdVaultSession = z.object({ url: z.string() });

export const vaultCards = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			brand: z.string(),
			last4: z.string(),
			expiry_month: z.number(),
			expiry_year: z.number()
		})
	)
});

export const agentcardAuthorization = z.object({
	id: z.string(),
	status: z.enum(['awaiting_approval', 'approved', 'submitted_on_device', 'declined', 'expired']),
	amount: z.number().nullable(),
	currency: z.string().nullable(),
	approvalUrl: z.string().optional(),
	poll_interval_ms: z.number().optional(),
	reason: z.string().optional(),
	replay_attempted: z.boolean().nullish(),
	settlement: z.object({ status: z.string().optional() }).nullish(),
	response: z
		.object({ status: z.number(), headers: z.record(z.string(), z.string()), body: z.string() })
		.optional()
});

export type AgentcardAuthorization = z.infer<typeof agentcardAuthorization>;

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
