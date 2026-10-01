import {
	action,
	env,
	internalAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { z } from 'zod';
import { getExecutionRun, getExecutionRunRecord } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';

const WORKOS_VAULT_ORIGIN = 'https://api.workos.com';

const OPENAI_API_ORIGIN = 'https://api.openai.com';

const CHATGPT_AUTH_ORIGIN = 'https://auth.openai.com';

const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const OPENAI_CREDENTIAL_NAME_PREFIX = 'sprocket-openai-';

const CHATGPT_CREDENTIAL_NAME_PREFIX = 'sprocket-chatgpt-';

const PROVIDER_FETCH_TIMEOUT_MS = 20_000;

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

const CLEANUP_BATCH_SIZE = 4;

const CLEANUP_REVOCATION_ATTEMPTS = 2;

const CLEANUP_FETCH_TIMEOUT_MS = 5_000;

const CLOUD_CHATGPT_RETIRED_MESSAGE =
	'Cloud-held ChatGPT sign-in is retired. Connect ChatGPT locally in the Sprocket app with sign in with ChatGPT (SIWC).';

const vaultObjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	value: z.string(),
	metadata: z.object({ version_id: z.string().min(1) })
});

type VaultObject = z.infer<typeof vaultObjectSchema>;

const vaultObjectDigestSchema = z.object({
	id: z.string(),
	name: z.string()
});

const vaultObjectListSchema = z.object({
	data: z.array(vaultObjectDigestSchema),
	list_metadata: z.looseObject({ after: z.string().optional() })
});

const chatGptCredentialSchema = z.object({
	version: z.literal(1),
	connectionId: z.string().min(1),
	accessToken: z
		.string()
		.min(1)
		.max(128 * 1024),
	refreshToken: z
		.string()
		.min(1)
		.max(128 * 1024),
	accountId: z.string().min(1).max(512),
	residency: z.string().min(1).max(128).optional(),
	expiresAt: z.number().int().positive()
});

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

async function listVaultObjects(
	after: string | null
): Promise<{ objects: { id: string; name: string }[]; after: string | null }> {
	const url = new URL(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv`);
	url.searchParams.set('limit', String(CLEANUP_BATCH_SIZE));

	if (after) url.searchParams.set('after', after);
	const response = await providerFetch(url, { headers: workosHeaders() });

	if (!response.ok) throw new Error('Couldn’t list provider credentials in WorkOS Vault.');
	const page = await responseJson(response, 'WorkOS Vault', vaultObjectListSchema);

	return { objects: page.data, after: page.list_metadata.after ?? null };
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

function retiredCloudChatGpt(): never {
	throw new Error(CLOUD_CHATGPT_RETIRED_MESSAGE);
}

// Retired cloud-held ChatGPT sign-in and credential issuance. Released
// clients still call these; every one rejects with the local SIWC guidance
// while keeping its original argument validator.
export const beginChatGptBrowserLogin = action({
	args: { state: v.string() },
	returns: v.string(),
	handler: async () => retiredCloudChatGpt()
});

export const completeChatGptBrowserLogin = action({
	args: { state: v.string(), code: v.string() },
	returns: v.union(v.array(v.string()), v.null()),
	handler: async () => retiredCloudChatGpt()
});

export const cancelChatGptBrowserLogin = action({
	args: { state: v.string() },
	returns: v.null(),
	handler: async () => retiredCloudChatGpt()
});

export const beginChatGptDeviceLogin = action({
	args: {},
	returns: v.object({
		deviceAuthId: v.string(),
		userCode: v.string(),
		verificationUrl: v.string(),
		intervalMs: v.number(),
		expiresAt: v.number()
	}),
	handler: async () => retiredCloudChatGpt()
});

export const pollChatGptDeviceLogin = action({
	args: { deviceAuthId: v.string(), userCode: v.string() },
	returns: v.union(
		v.object({ status: v.literal('pending') }),
		v.object({
			status: v.literal('connected'),
			modelIds: v.union(v.array(v.string()), v.null())
		})
	),
	handler: async () => retiredCloudChatGpt()
});

export const cancelChatGptDeviceLogin = action({
	args: { deviceAuthId: v.string(), userCode: v.string() },
	returns: v.null(),
	handler: async () => retiredCloudChatGpt()
});

export const refreshChatGptModels = action({
	args: {},
	returns: v.array(v.string()),
	handler: async () => retiredCloudChatGpt()
});

export const removeChatGptCredential = action({
	args: {},
	returns: v.null(),
	handler: async () => retiredCloudChatGpt()
});

export const issueChatGptCredential = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.object({
		accessToken: v.string(),
		connectionId: v.string(),
		accountId: v.string(),
		residency: v.optional(v.string()),
		expiresAt: v.number()
	}),
	handler: async () => retiredCloudChatGpt()
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

		if ((run.completionProvider ?? 'spikonado') !== 'openai') {
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

export const chatGptConnection = query({
	args: { runId: v.id('runs'), executionSecret: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

		if (run.completionProvider !== 'chatgpt') {
			throw new Error('Run is not configured to use ChatGPT.');
		}

		// Historical chatgpt runs keep their rows, but the cloud-held connection
		// is retired, so there is never a live connection id to report.
		return null;
	}
});

function chatGptState(ctx: QueryCtx, userId: string) {
	return ctx.db
		.query('providerCredentialStates')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();
}

async function revokeChatGptRefreshToken(refreshToken: string): Promise<void> {
	const response = await providerFetch(`${CHATGPT_AUTH_ORIGIN}/api/accounts/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: CHATGPT_CLIENT_ID,
			token_type_hint: 'refresh_token',
			token: refreshToken
		}).toString(),
		signal: AbortSignal.timeout(CLEANUP_FETCH_TIMEOUT_MS),
		redirect: 'error'
	});

	if (response.status === 400 || response.status === 401 || response.status === 403) {
		return;
	}

	if (!response.ok) throw new Error('ChatGPT could not revoke a retired credential.');
}

async function deleteRetiredChatGptCredential(object: VaultObject): Promise<void> {
	// Invalid stored JSON never blocks deletion of the Vault object.
	const parsed = chatGptCredentialSchema.safeParse(
		(() => {
			try {
				return JSON.parse(object.value);
			} catch {
				return null;
			}
		})()
	);

	if (parsed.success) {
		for (let attempt = 0; attempt < CLEANUP_REVOCATION_ATTEMPTS; attempt += 1) {
			try {
				await revokeChatGptRefreshToken(parsed.data.refreshToken);
				break;
			} catch {
				if (attempt + 1 < CLEANUP_REVOCATION_ATTEMPTS) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
		}
	}

	const url = new URL(`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(object.id)}`);
	url.searchParams.set('version_check', object.metadata.version_id);
	const response = await providerFetch(url, { method: 'DELETE', headers: workosHeaders() });

	if (!response.ok && response.status !== 404) {
		throw new Error('Couldn’t remove the provider credential from WorkOS Vault.');
	}
}

export const listChatGptCredentialStates = internalQuery({
	args: { cursor: v.union(v.string(), v.null()), batchSize: v.number() },
	returns: v.object({
		userIds: v.array(v.string()),
		continueCursor: v.union(v.string(), v.null()),
		isDone: v.boolean()
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('providerCredentialStates')
			.paginate({ numItems: args.batchSize, cursor: args.cursor });

		return {
			userIds: page.page.map((state) => state.userId),
			continueCursor: page.continueCursor,
			isDone: page.isDone
		};
	}
});

export const deleteChatGptCredentialState = internalMutation({
	args: { userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);

		if (state) await ctx.db.delete(state._id);

		return null;
	}
});

export const retireChatGptCloudCredentials = internalAction({
	args: {
		cursor: v.union(v.string(), v.null()),
		vaultAfter: v.union(v.string(), v.null()),
		tableScanDone: v.boolean()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!args.tableScanDone) {
			const batch: { userIds: string[]; continueCursor: string | null; isDone: boolean } =
				await ctx.runQuery(internal.providerCredentials.listChatGptCredentialStates, {
					cursor: args.cursor,
					batchSize: CLEANUP_BATCH_SIZE
				});

			const done = batch.isDone;

			if (batch.userIds.length > 0) {
				for (const userId of batch.userIds) {
					const name = await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, userId);
					const object = await readVaultObject(name);

					if (object) await deleteRetiredChatGptCredential(object);
					await ctx.runMutation(internal.providerCredentials.deleteChatGptCredentialState, {
						userId
					});
				}
			}

			await ctx.scheduler.runAfter(0, internal.providerCredentials.retireChatGptCloudCredentials, {
				cursor: done ? null : batch.continueCursor,
				vaultAfter: args.vaultAfter,
				tableScanDone: done
			});

			return null;
		}

		const page = await listVaultObjects(args.vaultAfter);

		if (args.vaultAfter) {
			const response = await providerFetch(
				`${WORKOS_VAULT_ORIGIN}/vault/v1/kv/${encodeURIComponent(args.vaultAfter)}`,
				{ headers: workosHeaders() }
			);

			if (response.status !== 404) {
				if (!response.ok) throw new Error('Could not read the retirement cursor in WorkOS Vault.');
				const object = await responseJson(response, 'WorkOS Vault', vaultObjectSchema);

				if (object.id !== args.vaultAfter)
					throw new Error('WorkOS Vault returned an invalid cursor object.');

				if (object.name.startsWith(CHATGPT_CREDENTIAL_NAME_PREFIX)) {
					await deleteRetiredChatGptCredential(object);
				}
			}
		}

		for (const digest of page.objects) {
			if (!digest.name.startsWith(CHATGPT_CREDENTIAL_NAME_PREFIX)) continue;

			// Keep the next cursor object until its page has been fetched.
			if (digest.id === page.after) continue;
			const object = await readVaultObject(digest.name);

			if (object) await deleteRetiredChatGptCredential(object);
		}

		if (page.after !== null) {
			await ctx.scheduler.runAfter(0, internal.providerCredentials.retireChatGptCloudCredentials, {
				cursor: args.cursor,
				vaultAfter: page.after,
				tableScanDone: true
			});
		}

		return null;
	}
});
