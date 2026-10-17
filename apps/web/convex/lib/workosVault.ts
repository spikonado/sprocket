import { env } from '@convex/_generated/server';
import { z } from 'zod';

const WORKOS_VAULT_ORIGIN = 'https://api.workos.com';

const PROVIDER_FETCH_TIMEOUT_MS = 20_000;

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

const vaultObjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	value: z.string(),
	metadata: z.object({ version_id: z.string().min(1) })
});

export type VaultObject = z.infer<typeof vaultObjectSchema>;

function workosApiKey(): string {
	const key = env.WORKOS_API_KEY?.trim();

	if (!key) throw new Error('Provider settings are not configured on this Sprocket deployment.');

	return key;
}

function workosClientId(): string {
	const clientId = env.WORKOS_CLIENT_ID?.trim();

	if (!clientId) {
		throw new Error('Provider settings are not configured on this Sprocket deployment.');
	}

	return clientId;
}

/** A per-user vault name that doesn't reveal the user ID. */
export async function credentialName(prefix: string, userId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));

	const suffix = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

	return `${prefix}${suffix}`;
}

function workosHeaders(): HeadersInit {
	return {
		authorization: `Bearer ${workosApiKey()}`,
		'content-type': 'application/json'
	};
}

export function providerFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	return fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)
	});
}

async function responseJson<T>(
	response: Response,
	service: string,
	schema: z.ZodType<T>,
	invalidMessage = `${service} returned an invalid response.`
): Promise<T> {
	const contentLength = Number(response.headers.get('content-length'));

	if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
		throw new Error(`${service} returned an oversized response.`);
	}

	const reader = response.body?.getReader();

	if (!reader) throw new Error(`${service} returned an invalid response.`);
	const chunks: Uint8Array[] = [];
	let byteLength = 0;

	while (true) {
		const { done, value } = await reader.read();

		if (done) break;
		byteLength += value.byteLength;

		if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error(`${service} returned an oversized response.`);
		}

		chunks.push(value);
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	let data: T;

	try {
		data = schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new Error(invalidMessage);
	}

	return data;
}

export async function readVaultObject(name: string): Promise<VaultObject | null> {
	const response = await providerFetch(
		`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/name/${encodeURIComponent(name)}`,
		{ headers: workosHeaders() }
	);

	if (response.status === 404) return null;

	if (!response.ok) throw new Error('Couldn’t read the credential from WorkOS Vault.');

	const object = await responseJson(
		response,
		'WorkOS Vault',
		vaultObjectSchema,
		'WorkOS Vault returned an invalid credential.'
	);

	if (object.name !== name) {
		throw new Error('WorkOS Vault returned an invalid credential.');
	}

	return object;
}

/** Pass the object read earlier to fail instead of overwriting a concurrent change. */
export async function storeVaultObject(
	name: string,
	value: string,
	existingObject?: VaultObject | null
): Promise<void> {
	const existing = existingObject === undefined ? await readVaultObject(name) : existingObject;

	const response = existing
		? await providerFetch(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(existing.id)}`, {
				method: 'PUT',
				headers: workosHeaders(),
				body: JSON.stringify({ value, version_check: existing.metadata.version_id })
			})
		: await providerFetch(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv`, {
				method: 'POST',
				headers: workosHeaders(),
				body: JSON.stringify({
					key_context: { application_id: workosClientId() },
					name,
					value
				})
			});

	if (!response.ok) throw new Error('Couldn’t save the credential in WorkOS Vault.');
}

export async function deleteVaultObject(name: string, existingObject?: VaultObject | null) {
	const object = existingObject === undefined ? await readVaultObject(name) : existingObject;

	if (!object) return;
	const url = new URL(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(object.id)}`);
	url.searchParams.set('version_check', object.metadata.version_id);
	const response = await providerFetch(url, { method: 'DELETE', headers: workosHeaders() });

	if (!response.ok && response.status !== 404) {
		throw new Error('Couldn’t remove the credential from WorkOS Vault.');
	}
}
