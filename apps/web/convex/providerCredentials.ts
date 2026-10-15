import { action, env, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { z } from 'zod';
import { getExecutionRun } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { getProviderHandoff } from '@convex/lib/contextHandoff';

const WORKOS_VAULT_ORIGIN = 'https://api.workos.com';

const OPENAI_API_ORIGIN = 'https://api.openai.com';

const OPENAI_CREDENTIAL_NAME_PREFIX = 'sprocket-openai-';

const PROVIDER_FETCH_TIMEOUT_MS = 20_000;

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

const vaultObjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	value: z.string(),
	metadata: z.object({ version_id: z.string().min(1) })
});

type VaultObject = z.infer<typeof vaultObjectSchema>;

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

async function credentialName(prefix: string, userId: string): Promise<string> {
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

function providerFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
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

async function readVaultObject(name: string): Promise<VaultObject | null> {
	const response = await providerFetch(
		`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/name/${encodeURIComponent(name)}`,
		{ headers: workosHeaders() }
	);

	if (response.status === 404) return null;

	if (!response.ok) throw new Error('Couldn’t read the provider credential from WorkOS Vault.');

	const object = await responseJson(
		response,
		'WorkOS Vault',
		vaultObjectSchema,
		'WorkOS Vault returned an invalid provider credential.'
	);

	if (object.name !== name) {
		throw new Error('WorkOS Vault returned an invalid provider credential.');
	}

	return object;
}

async function storeVaultObject(
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

	if (!response.ok) throw new Error('Couldn’t save the provider credential in WorkOS Vault.');
}

async function deleteVaultObject(name: string): Promise<void> {
	const object = await readVaultObject(name);

	if (!object) return;
	const url = new URL(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(object.id)}`);
	url.searchParams.set('version_check', object.metadata.version_id);
	const response = await providerFetch(url, { method: 'DELETE', headers: workosHeaders() });

	if (!response.ok && response.status !== 404) {
		throw new Error('Couldn’t remove the provider credential from WorkOS Vault.');
	}
}

async function validateOpenAiKey(apiKey: string): Promise<void> {
	const response = await providerFetch(`${OPENAI_API_ORIGIN}/v1/models`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});

	if (response.status === 401 || response.status === 403) {
		throw new Error('OpenAI rejected this API key.');
	}

	if (!response.ok) {
		throw new Error('OpenAI could not validate this API key. Try again in a moment.');
	}
}

export const getMyConfiguration = action({
	args: {},
	returns: v.object({
		openai: v.boolean(),
		chatgpt: v.boolean(),
		chatgptModelIds: v.union(v.array(v.string()), v.null())
	}),
	handler: async (
		ctx: ActionCtx
	): Promise<{ openai: boolean; chatgpt: boolean; chatgptModelIds: string[] | null }> => {
		const identity = await ctx.auth.getUserIdentity();

		if (!identity) throw new Error('Authentication required.');

		const openAiObject: VaultObject | null = await readVaultObject(
			await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject)
		);

		// Cloud-held ChatGPT is retired; released clients read these fields to
		// render the connection state and must see it as disconnected.
		return { openai: openAiObject !== null, chatgpt: false, chatgptModelIds: null };
	}
});

export const saveOpenAiKey = action({
	args: { apiKey: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();

		if (!identity) throw new Error('Authentication required.');
		const apiKey = args.apiKey.trim();

		if (!apiKey || apiKey.length > 512) throw new Error('Enter a valid OpenAI API key.');
		await validateOpenAiKey(apiKey);
		await storeVaultObject(
			await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject),
			apiKey
		);

		return null;
	}
});

export const removeOpenAiKey = action({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();

		if (!identity) throw new Error('Authentication required.');
		await deleteVaultObject(await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject));

		return null;
	}
});

export const authorizeOpenAiCredential = internalQuery({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.claimId, Date.now())
		) {
			throw new Error(RUN_NO_LONGER_ACTIVE);
		}

		if (
			(run.completionProvider ?? 'spikonado') !== 'openai' &&
			(await getProviderHandoff(ctx, run, await ctx.db.get('threadRecords', run.threadId)))
				?.completionProvider !== 'openai'
		) {
			throw new Error('Run is not configured to use OpenAI directly.');
		}

		return run.userId;
	}
});

export const issueOpenAiCredential = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.object({ apiKey: v.string() }),
	handler: async (ctx, args) => {
		const userId: string = await ctx.runQuery(
			internal.providerCredentials.authorizeOpenAiCredential,
			args
		);

		const object = await readVaultObject(
			await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, userId)
		);

		if (!object) throw new Error('OpenAI is no longer configured. Add an API key in Settings.');
		await ctx.runQuery(internal.providerCredentials.authorizeOpenAiCredential, args);

		return { apiKey: object.value };
	}
});
