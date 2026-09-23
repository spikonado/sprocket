import {
	action,
	env,
	internalMutation,
	internalQuery,
	type ActionCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { z } from 'zod';
import { getExecutionRun } from '@convex/lib/auth';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';

const WORKOS_VAULT_ORIGIN = 'https://api.workos.com';
const OPENAI_API_ORIGIN = 'https://api.openai.com';
const CHATGPT_AUTH_ORIGIN = 'https://auth.openai.com';
const CHATGPT_API_ORIGIN = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_VERIFICATION_URL = `${CHATGPT_AUTH_ORIGIN}/codex/device`;
const OPENAI_CREDENTIAL_NAME_PREFIX = 'sprocket-openai-';
const CHATGPT_CREDENTIAL_NAME_PREFIX = 'sprocket-chatgpt-';
const CHATGPT_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const CHATGPT_REFRESH_LEASE_MS = 90_000;
const CHATGPT_REFRESH_WAIT_ATTEMPTS = 60;
const CHATGPT_REFRESH_WAIT_MS = 500;
const PROVIDER_FETCH_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

const vaultObjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	value: z.string(),
	metadata: z.object({ version_id: z.string().min(1) })
});
type VaultObject = z.infer<typeof vaultObjectSchema>;

const chatGptCredentialSchema = z.object({
	version: z.literal(1),
	accessToken: z
		.string()
		.min(1)
		.max(128 * 1024),
	refreshToken: z
		.string()
		.min(1)
		.max(128 * 1024),
	idToken: z
		.string()
		.min(1)
		.max(128 * 1024)
		.optional(),
	accountId: z.string().min(1).max(512),
	residency: z.string().min(1).max(128).optional(),
	expiresAt: z.number().int().positive()
});
type ChatGptCredential = z.infer<typeof chatGptCredentialSchema>;
type StoredChatGptCredential = { credential: ChatGptCredential; vaultObject: VaultObject };

const chatGptDeviceCodeSchema = z.object({
	device_auth_id: z.string().min(1).max(512),
	user_code: z.string().min(1).max(128),
	interval: z.union([z.string(), z.number()]).optional()
});
const chatGptDeviceAuthorizationSchema = z.object({
	authorization_code: z.string().min(1).max(4096),
	code_verifier: z.string().min(1).max(4096)
});
const chatGptTokenSchema = z.object({
	access_token: z
		.string()
		.min(1)
		.max(128 * 1024),
	refresh_token: z
		.string()
		.min(1)
		.max(128 * 1024)
		.optional(),
	id_token: z
		.string()
		.min(1)
		.max(128 * 1024)
		.optional(),
	expires_in: z.number().positive().optional()
});
type ChatGptTokenResponse = z.infer<typeof chatGptTokenSchema>;
const chatGptModelsSchema = z.object({
	models: z.array(z.looseObject({ slug: z.string().min(1).max(256) })).max(1_000)
});
const jwtClaimsSchema = z.looseObject({
	exp: z.number().optional(),
	chatgpt_account_id: z.string().min(1).max(512).optional(),
	chatgpt_compute_residency: z.string().min(1).max(128).optional(),
	organizations: z
		.array(z.object({ id: z.string().min(1).max(512) }))
		.max(1_000)
		.optional(),
	'https://api.openai.com/auth': z
		.looseObject({
			chatgpt_account_id: z.string().min(1).max(512).optional(),
			chatgpt_compute_residency: z.string().min(1).max(128).optional()
		})
		.optional()
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
	return fetch(input, { ...init, signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS) });
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

function parseJwtClaims(token: string): z.infer<typeof jwtClaimsSchema> | null {
	const payload = token.split('.')[1];
	if (!payload) return null;
	try {
		const base64 = payload
			.replaceAll('-', '+')
			.replaceAll('_', '/')
			.padEnd(Math.ceil(payload.length / 4) * 4, '=');
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		const parsed = jwtClaimsSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function chatGptCredentialFromTokens(
	tokens: ChatGptTokenResponse,
	previous?: ChatGptCredential
): ChatGptCredential {
	const idClaims = tokens.id_token ? parseJwtClaims(tokens.id_token) : null;
	const accessClaims = parseJwtClaims(tokens.access_token);
	const accountId =
		idClaims?.['https://api.openai.com/auth']?.chatgpt_account_id ??
		idClaims?.chatgpt_account_id ??
		idClaims?.organizations?.[0]?.id ??
		accessClaims?.['https://api.openai.com/auth']?.chatgpt_account_id ??
		accessClaims?.chatgpt_account_id ??
		accessClaims?.organizations?.[0]?.id ??
		previous?.accountId;
	if (!accountId) throw new Error('ChatGPT did not return an account identifier.');
	const residency =
		accessClaims?.['https://api.openai.com/auth']?.chatgpt_compute_residency ??
		accessClaims?.chatgpt_compute_residency ??
		idClaims?.['https://api.openai.com/auth']?.chatgpt_compute_residency ??
		idClaims?.chatgpt_compute_residency ??
		previous?.residency;
	const expiresAt = accessClaims?.exp
		? accessClaims.exp * 1_000
		: Date.now() + (tokens.expires_in ?? 3_600) * 1_000;
	const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
	if (!refreshToken) throw new Error('ChatGPT did not return a refresh token.');
	return {
		version: 1,
		accessToken: tokens.access_token,
		refreshToken,
		idToken: tokens.id_token ?? previous?.idToken,
		accountId,
		residency: residency === 'no_constraint' ? undefined : residency,
		expiresAt
	};
}

async function readChatGptCredential(userId: string): Promise<StoredChatGptCredential | null> {
	const object = await readVaultObject(
		await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, userId)
	);
	if (!object) return null;
	let value: unknown;
	try {
		value = JSON.parse(object.value);
	} catch {
		throw new Error('The stored ChatGPT credential is invalid. Reconnect ChatGPT.');
	}
	const parsed = chatGptCredentialSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error('The stored ChatGPT credential is invalid. Reconnect ChatGPT.');
	}
	return { credential: parsed.data, vaultObject: object };
}

async function storeChatGptCredential(
	userId: string,
	credential: ChatGptCredential,
	existingObject?: VaultObject | null
): Promise<void> {
	await storeVaultObject(
		await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, userId),
		JSON.stringify(credential),
		existingObject
	);
}

async function exchangeChatGptCode(
	authorizationCode: string,
	codeVerifier: string
): Promise<ChatGptTokenResponse> {
	const response = await providerFetch(`${CHATGPT_AUTH_ORIGIN}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: authorizationCode,
			redirect_uri: `${CHATGPT_AUTH_ORIGIN}/deviceauth/callback`,
			client_id: CHATGPT_CLIENT_ID,
			code_verifier: codeVerifier
		}).toString()
	});
	if (!response.ok) throw new Error('ChatGPT could not complete sign-in. Start again.');
	return responseJson(
		response,
		'ChatGPT',
		chatGptTokenSchema,
		'ChatGPT returned an invalid sign-in response.'
	);
}

async function refreshChatGptCredential(credential: ChatGptCredential): Promise<ChatGptCredential> {
	const response = await providerFetch(`${CHATGPT_AUTH_ORIGIN}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: CHATGPT_CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: credential.refreshToken
		}).toString()
	});
	if (response.status === 400 || response.status === 401 || response.status === 403) {
		throw new Error('ChatGPT sign-in expired. Reconnect ChatGPT in Settings.');
	}
	if (!response.ok) throw new Error('ChatGPT could not refresh your sign-in. Try again shortly.');
	const tokens = await responseJson(
		response,
		'ChatGPT',
		chatGptTokenSchema,
		'ChatGPT returned an invalid token refresh response.'
	);
	return chatGptCredentialFromTokens(tokens, credential);
}

async function chatGptModelIds(credential: ChatGptCredential): Promise<string[] | null> {
	try {
		const headers = new Headers({
			authorization: `Bearer ${credential.accessToken}`,
			'ChatGPT-Account-ID': credential.accountId,
			originator: 'sprocket',
			'user-agent': 'Sprocket'
		});
		if (credential.residency) {
			headers.set('x-openai-internal-codex-residency', credential.residency);
		}
		const response = await providerFetch(`${CHATGPT_API_ORIGIN}/models?client_version=0.0.0`, {
			headers
		});
		if (!response.ok) return null;
		const models = await responseJson(response, 'ChatGPT', chatGptModelsSchema);
		return [...new Set(models.models.map((model) => model.slug))];
	} catch {
		return null;
	}
}

async function acquireChatGptLease(ctx: ActionCtx, userId: string, leaseId: string): Promise<void> {
	for (let attempt = 0; attempt < CHATGPT_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
		const acquired: boolean = await ctx.runMutation(
			internal.providerCredentials.acquireChatGptCredentialLease,
			{ userId, leaseId }
		);
		if (acquired) return;
		await new Promise((resolve) => setTimeout(resolve, CHATGPT_REFRESH_WAIT_MS));
	}
	throw new Error('ChatGPT credentials are busy. Try again shortly.');
}

async function renewChatGptLease(ctx: ActionCtx, userId: string, leaseId: string): Promise<void> {
	const renewed: boolean = await ctx.runMutation(
		internal.providerCredentials.renewChatGptCredentialLease,
		{ userId, leaseId }
	);
	if (!renewed) throw new Error('ChatGPT credential update lost its lease. Try again.');
}

async function resolveChatGptCredential(
	ctx: ActionCtx,
	userId: string
): Promise<ChatGptCredential> {
	let stored = await readChatGptCredential(userId);
	if (!stored) throw new Error('ChatGPT is no longer connected. Reconnect in Settings.');
	if (stored.credential.expiresAt > Date.now() + CHATGPT_REFRESH_MARGIN_MS) {
		return stored.credential;
	}

	const leaseId = crypto.randomUUID();
	await acquireChatGptLease(ctx, userId, leaseId);
	try {
		stored = await readChatGptCredential(userId);
		if (!stored) throw new Error('ChatGPT is no longer connected. Reconnect in Settings.');
		let credential = stored.credential;
		if (credential.expiresAt <= Date.now() + CHATGPT_REFRESH_MARGIN_MS) {
			await renewChatGptLease(ctx, userId, leaseId);
			credential = await refreshChatGptCredential(credential);
			await renewChatGptLease(ctx, userId, leaseId);
			await storeChatGptCredential(userId, credential, stored.vaultObject);
		}
		await ctx.runMutation(internal.providerCredentials.releaseChatGptCredentialLease, {
			userId,
			leaseId,
			expiresAt: credential.expiresAt
		});
		return credential;
	} catch (error) {
		await ctx.runMutation(internal.providerCredentials.releaseChatGptCredentialLease, {
			userId,
			leaseId
		});
		throw error;
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
		const [openAiObject, chatGptObject, chatGptState]: [
			VaultObject | null,
			VaultObject | null,
			{ expiresAt: number; modelIds?: string[] } | null
		] = await Promise.all([
			readVaultObject(await credentialName(OPENAI_CREDENTIAL_NAME_PREFIX, identity.subject)),
			readVaultObject(await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, identity.subject)),
			ctx.runQuery(internal.providerCredentials.getChatGptCredentialState, {
				userId: identity.subject
			})
		]);
		return {
			openai: openAiObject !== null,
			chatgpt: chatGptObject !== null,
			chatgptModelIds: chatGptState?.modelIds ?? null
		};
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

export const beginChatGptDeviceLogin = action({
	args: {},
	returns: v.object({
		deviceAuthId: v.string(),
		userCode: v.string(),
		verificationUrl: v.string(),
		intervalMs: v.number(),
		expiresAt: v.number()
	}),
	handler: async (ctx) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('Authentication required.');
		const response = await providerFetch(
			`${CHATGPT_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', 'user-agent': 'Sprocket' },
				body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID })
			}
		);
		if (!response.ok) {
			throw new Error(
				'ChatGPT device sign-in is unavailable. Check your ChatGPT security settings.'
			);
		}
		const deviceCode = await responseJson(
			response,
			'ChatGPT',
			chatGptDeviceCodeSchema,
			'ChatGPT returned an invalid device sign-in response.'
		);
		const intervalSeconds = Math.max(Number(deviceCode.interval) || 5, 1);
		return {
			deviceAuthId: deviceCode.device_auth_id,
			userCode: deviceCode.user_code,
			verificationUrl: CHATGPT_VERIFICATION_URL,
			intervalMs: intervalSeconds * 1_000,
			expiresAt: Date.now() + 15 * 60 * 1_000
		};
	}
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
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		if (
			!args.deviceAuthId.trim() ||
			args.deviceAuthId.length > 512 ||
			!args.userCode.trim() ||
			args.userCode.length > 128
		) {
			throw new Error('Invalid ChatGPT device sign-in request.');
		}
		const response = await providerFetch(`${CHATGPT_AUTH_ORIGIN}/api/accounts/deviceauth/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'Sprocket' },
			body: JSON.stringify({
				device_auth_id: args.deviceAuthId,
				user_code: args.userCode
			})
		});
		if (response.status === 403 || response.status === 404) return { status: 'pending' as const };
		if (!response.ok) throw new Error('ChatGPT device sign-in failed. Start again.');
		const authorization = await responseJson(
			response,
			'ChatGPT',
			chatGptDeviceAuthorizationSchema,
			'ChatGPT returned an invalid device authorization response.'
		);

		const leaseId = crypto.randomUUID();
		await acquireChatGptLease(ctx, identity.subject, leaseId);
		try {
			await renewChatGptLease(ctx, identity.subject, leaseId);
			const tokens = await exchangeChatGptCode(
				authorization.authorization_code,
				authorization.code_verifier
			);
			const credential = chatGptCredentialFromTokens(tokens);
			const modelIds = await chatGptModelIds(credential);
			await renewChatGptLease(ctx, identity.subject, leaseId);
			await storeChatGptCredential(identity.subject, credential);
			await ctx.runMutation(internal.providerCredentials.recordChatGptCredential, {
				userId: identity.subject,
				leaseId,
				expiresAt: credential.expiresAt,
				modelIds: modelIds ?? undefined
			});
			return { status: 'connected' as const, modelIds };
		} catch (error) {
			await ctx.runMutation(internal.providerCredentials.releaseChatGptCredentialLease, {
				userId: identity.subject,
				leaseId
			});
			throw error;
		}
	}
});

export const removeChatGptCredential = action({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		const leaseId = crypto.randomUUID();
		await acquireChatGptLease(ctx, identity.subject, leaseId);
		try {
			await deleteVaultObject(
				await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, identity.subject)
			);
			await ctx.runMutation(internal.providerCredentials.deleteChatGptCredentialState, {
				userId: identity.subject,
				leaseId
			});
			return null;
		} catch (error) {
			await ctx.runMutation(internal.providerCredentials.releaseChatGptCredentialLease, {
				userId: identity.subject,
				leaseId
			});
			throw error;
		}
	}
});

export const getChatGptCredentialState = internalQuery({
	args: { userId: v.string() },
	returns: v.union(
		v.object({ expiresAt: v.number(), modelIds: v.optional(v.array(v.string())) }),
		v.null()
	),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('providerCredentialStates')
			.withIndex('by_userId_and_provider', (query) =>
				query.eq('userId', args.userId).eq('provider', 'chatgpt')
			)
			.unique();
		return state ? { expiresAt: state.expiresAt, modelIds: state.modelIds } : null;
	}
});

export const acquireChatGptCredentialLease = internalMutation({
	args: { userId: v.string(), leaseId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const state = await ctx.db
			.query('providerCredentialStates')
			.withIndex('by_userId_and_provider', (query) =>
				query.eq('userId', args.userId).eq('provider', 'chatgpt')
			)
			.unique();
		if (
			state?.refreshLeaseId &&
			state.refreshLeaseId !== args.leaseId &&
			(state.refreshLeaseExpiresAt ?? 0) > now
		) {
			return false;
		}
		if (state) {
			await ctx.db.patch(state._id, {
				refreshLeaseId: args.leaseId,
				refreshLeaseExpiresAt: now + CHATGPT_REFRESH_LEASE_MS,
				updatedAt: now
			});
		} else {
			await ctx.db.insert('providerCredentialStates', {
				userId: args.userId,
				provider: 'chatgpt',
				expiresAt: 0,
				refreshLeaseId: args.leaseId,
				refreshLeaseExpiresAt: now + CHATGPT_REFRESH_LEASE_MS,
				updatedAt: now
			});
		}
		return true;
	}
});

export const releaseChatGptCredentialLease = internalMutation({
	args: { userId: v.string(), leaseId: v.string(), expiresAt: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('providerCredentialStates')
			.withIndex('by_userId_and_provider', (query) =>
				query.eq('userId', args.userId).eq('provider', 'chatgpt')
			)
			.unique();
		if (state?.refreshLeaseId !== args.leaseId) return null;
		await ctx.db.patch(state._id, {
			expiresAt: args.expiresAt ?? state.expiresAt,
			refreshLeaseId: undefined,
			refreshLeaseExpiresAt: undefined,
			updatedAt: Date.now()
		});
		return null;
	}
});

export const renewChatGptCredentialLease = internalMutation({
	args: { userId: v.string(), leaseId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('providerCredentialStates')
			.withIndex('by_userId_and_provider', (query) =>
				query.eq('userId', args.userId).eq('provider', 'chatgpt')
			)
			.unique();
		if (state?.refreshLeaseId !== args.leaseId) return false;
		const now = Date.now();
		await ctx.db.patch(state._id, {
			refreshLeaseExpiresAt: now + CHATGPT_REFRESH_LEASE_MS,
			updatedAt: now
		});
		return true;
	}
});

export const recordChatGptCredential = internalMutation({
	args: {
		userId: v.string(),
		leaseId: v.string(),
		expiresAt: v.number(),
		modelIds: v.optional(v.array(v.string()))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('providerCredentialStates')
			.withIndex('by_userId_and_provider', (query) =>
				query.eq('userId', args.userId).eq('provider', 'chatgpt')
			)
			.unique();
		if (!state || state.refreshLeaseId !== args.leaseId) {
			throw new Error('ChatGPT credential update lost its lease.');
		}
		await ctx.db.patch(state._id, {
			expiresAt: args.expiresAt,
			modelIds: args.modelIds,
			refreshLeaseId: undefined,
			refreshLeaseExpiresAt: undefined,
			updatedAt: Date.now()
		});
		return null;
	}
});

export const deleteChatGptCredentialState = internalMutation({
	args: { userId: v.string(), leaseId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('providerCredentialStates')
			.withIndex('by_userId_and_provider', (query) =>
				query.eq('userId', args.userId).eq('provider', 'chatgpt')
			)
			.unique();
		if (state?.refreshLeaseId === args.leaseId) await ctx.db.delete(state._id);
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

export const authorizeChatGptCredential = internalQuery({
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
		if ((run.completionProvider ?? 'spikonado') !== 'chatgpt') {
			throw new Error('Run is not configured to use ChatGPT.');
		}
		return run.userId;
	}
});

export const issueChatGptCredential = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.object({
		accessToken: v.string(),
		accountId: v.string(),
		residency: v.optional(v.string())
	}),
	handler: async (ctx, args) => {
		const userId: string = await ctx.runQuery(
			internal.providerCredentials.authorizeChatGptCredential,
			args
		);
		const credential = await resolveChatGptCredential(ctx, userId);
		await ctx.runQuery(internal.providerCredentials.authorizeChatGptCredential, args);
		return {
			accessToken: credential.accessToken,
			accountId: credential.accountId,
			residency: credential.residency
		};
	}
});
