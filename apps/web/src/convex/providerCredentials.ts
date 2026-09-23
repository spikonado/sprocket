import {
	action,
	env,
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
const CHATGPT_API_ORIGIN = 'https://chatgpt.com/backend-api/codex';
// Bump this when Codex requires a newer client version to return current models.
const CODEX_CLIENT_VERSION = '0.156.1';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_VERIFICATION_URL = `${CHATGPT_AUTH_ORIGIN}/codex/device`;
const CHATGPT_BROWSER_CALLBACK_URL = 'http://localhost:1455/auth/callback';
const OPENAI_CREDENTIAL_NAME_PREFIX = 'sprocket-openai-';
const CHATGPT_CREDENTIAL_NAME_PREFIX = 'sprocket-chatgpt-';
const CHATGPT_REFRESH_LEASE_MS = 90_000;
const CHATGPT_REFRESH_MARGIN_MS = 30_000;
const CHATGPT_REFRESH_WAIT_ATTEMPTS = 60;
const CHATGPT_REFRESH_WAIT_MS = 500;
const PROVIDER_FETCH_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

function chatGptState(ctx: QueryCtx, userId: string) {
	return ctx.db
		.query('providerCredentialStates')
		.withIndex('by_userId_and_provider', (query) =>
			query.eq('userId', userId).eq('provider', 'chatgpt')
		)
		.unique();
}

const vaultObjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	value: z.string(),
	metadata: z.object({ version_id: z.string().min(1) })
});
type VaultObject = z.infer<typeof vaultObjectSchema>;

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

async function deviceAuthHash(deviceAuthId: string, userCode: string): Promise<string> {
	return credentialName('', `${deviceAuthId}:${userCode}`);
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
		connectionId: previous?.connectionId ?? crypto.randomUUID(),
		accessToken: tokens.access_token,
		refreshToken,
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
	codeVerifier: string,
	redirectUri = `${CHATGPT_AUTH_ORIGIN}/deviceauth/callback`
): Promise<ChatGptTokenResponse> {
	const response = await providerFetch(`${CHATGPT_AUTH_ORIGIN}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: authorizationCode,
			redirect_uri: redirectUri,
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
		const response = await providerFetch(
			`${CHATGPT_API_ORIGIN}/models?client_version=${CODEX_CLIENT_VERSION}`,
			{ headers }
		);
		if (!response.ok) return null;
		const models = await responseJson(response, 'ChatGPT', chatGptModelsSchema);
		return [...new Set(models.models.map((model) => model.slug))];
	} catch {
		return null;
	}
}

async function acquireChatGptLease(
	ctx: ActionCtx,
	userId: string,
	leaseId: string,
	attempts = CHATGPT_REFRESH_WAIT_ATTEMPTS
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
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

async function releaseChatGptLease(
	ctx: ActionCtx,
	userId: string,
	leaseId: string,
	expiresAt?: number
): Promise<void> {
	await ctx.runMutation(internal.providerCredentials.releaseChatGptCredentialLease, {
		userId,
		leaseId,
		expiresAt
	});
}

async function resolveChatGptCredentialWithLease(
	ctx: ActionCtx,
	userId: string,
	leaseId: string
): Promise<ChatGptCredential> {
	const stored = await readChatGptCredential(userId);
	if (!stored) throw new Error('ChatGPT is no longer connected. Reconnect in Settings.');
	if (stored.credential.expiresAt > Date.now() + CHATGPT_REFRESH_MARGIN_MS) {
		return stored.credential;
	}
	await renewChatGptLease(ctx, userId, leaseId);
	const credential = await refreshChatGptCredential(stored.credential);
	await renewChatGptLease(ctx, userId, leaseId);
	await storeChatGptCredential(userId, credential, stored.vaultObject);
	return credential;
}

async function resolveChatGptCredential(
	ctx: ActionCtx,
	userId: string
): Promise<ChatGptCredential> {
	const stored = await readChatGptCredential(userId);
	if (!stored) throw new Error('ChatGPT is no longer connected. Reconnect in Settings.');
	if (stored.credential.expiresAt > Date.now() + CHATGPT_REFRESH_MARGIN_MS) {
		return stored.credential;
	}

	const leaseId = crypto.randomUUID();
	await acquireChatGptLease(ctx, userId, leaseId);
	try {
		const credential = await resolveChatGptCredentialWithLease(ctx, userId, leaseId);
		await releaseChatGptLease(ctx, userId, leaseId, credential.expiresAt);
		return credential;
	} catch (error) {
		await releaseChatGptLease(ctx, userId, leaseId);
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

export const beginChatGptBrowserLogin = action({
	args: { state: v.string() },
	returns: v.string(),
	handler: async (ctx, { state }) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid ChatGPT sign-in request.');
		const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', '');
		const digest = new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
		);
		const challenge = btoa(String.fromCharCode(...digest))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', '');
		await ctx.runMutation(internal.providerCredentials.registerChatGptBrowserLogin, {
			userId: identity.subject,
			hash: await credentialName('', state),
			verifier,
			expiresAt: Date.now() + 5 * 60_000
		});
		const url = new URL(`${CHATGPT_AUTH_ORIGIN}/oauth/authorize`);
		url.search = new URLSearchParams({
			response_type: 'code',
			client_id: CHATGPT_CLIENT_ID,
			redirect_uri: CHATGPT_BROWSER_CALLBACK_URL,
			scope: 'openid profile email offline_access',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			id_token_add_organizations: 'true',
			codex_cli_simplified_flow: 'true',
			state,
			originator: 'sprocket'
		}).toString();
		return url.toString();
	}
});

export const completeChatGptBrowserLogin = action({
	args: { state: v.string(), code: v.string() },
	returns: v.union(v.array(v.string()), v.null()),
	handler: async (ctx, { state, code }) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		if (!/^[a-f0-9]{64}$/.test(state) || !code || code.length > 4096) {
			throw new Error('Invalid ChatGPT sign-in request.');
		}
		const hash = await credentialName('', state);
		const leaseId = crypto.randomUUID();
		await acquireChatGptLease(ctx, identity.subject, leaseId);
		try {
			const verifier: string = await ctx.runQuery(
				internal.providerCredentials.authorizeChatGptBrowserLogin,
				{ userId: identity.subject, hash }
			);
			const tokens = await exchangeChatGptCode(code, verifier, CHATGPT_BROWSER_CALLBACK_URL);
			const credential = chatGptCredentialFromTokens(tokens);
			const modelIds = await chatGptModelIds(credential);
			await renewChatGptLease(ctx, identity.subject, leaseId);
			await ctx.runQuery(internal.providerCredentials.authorizeChatGptBrowserLogin, {
				userId: identity.subject,
				hash
			});
			await storeChatGptCredential(identity.subject, credential);
			await ctx.runMutation(internal.providerCredentials.recordChatGptBrowserCredential, {
				userId: identity.subject,
				leaseId,
				hash,
				connectionId: credential.connectionId,
				expiresAt: credential.expiresAt,
				modelIds: modelIds ?? undefined
			});
			return modelIds;
		} catch (error) {
			await releaseChatGptLease(ctx, identity.subject, leaseId);
			throw error;
		}
	}
});

export const cancelChatGptBrowserLogin = action({
	args: { state: v.string() },
	returns: v.null(),
	handler: async (ctx, { state }) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid ChatGPT sign-in request.');
		const hash = await credentialName('', state);
		const leaseId = crypto.randomUUID();
		await acquireChatGptLease(ctx, identity.subject, leaseId, 4 * CHATGPT_REFRESH_WAIT_ATTEMPTS);
		try {
			const completed: boolean = await ctx.runQuery(
				internal.providerCredentials.isCompletedChatGptBrowserLogin,
				{ userId: identity.subject, hash, leaseId }
			);
			if (completed) {
				await deleteVaultObject(
					await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, identity.subject)
				);
			}
			await ctx.runMutation(internal.providerCredentials.cancelChatGptBrowserLoginState, {
				userId: identity.subject,
				hash,
				leaseId
			});
			return null;
		} catch (error) {
			await releaseChatGptLease(ctx, identity.subject, leaseId);
			throw error;
		}
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
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
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
		const expiresAt = Date.now() + 15 * 60 * 1_000;
		await ctx.runMutation(internal.providerCredentials.registerChatGptDeviceLogin, {
			userId: identity.subject,
			hash: await deviceAuthHash(deviceCode.device_auth_id, deviceCode.user_code),
			expiresAt
		});
		return {
			deviceAuthId: deviceCode.device_auth_id,
			userCode: deviceCode.user_code,
			verificationUrl: CHATGPT_VERIFICATION_URL,
			intervalMs: intervalSeconds * 1_000,
			expiresAt
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
		const hash = await deviceAuthHash(args.deviceAuthId, args.userCode);
		await ctx.runQuery(internal.providerCredentials.authorizeChatGptDeviceLogin, {
			userId: identity.subject,
			hash
		});
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
			await ctx.runQuery(internal.providerCredentials.authorizeChatGptDeviceLogin, {
				userId: identity.subject,
				hash
			});
			await renewChatGptLease(ctx, identity.subject, leaseId);
			const tokens = await exchangeChatGptCode(
				authorization.authorization_code,
				authorization.code_verifier
			);
			const credential = chatGptCredentialFromTokens(tokens);
			const modelIds = await chatGptModelIds(credential);
			await renewChatGptLease(ctx, identity.subject, leaseId);
			await ctx.runQuery(internal.providerCredentials.authorizeChatGptDeviceLogin, {
				userId: identity.subject,
				hash
			});
			await storeChatGptCredential(identity.subject, credential);
			await ctx.runMutation(internal.providerCredentials.recordChatGptCredential, {
				userId: identity.subject,
				leaseId,
				deviceAuthHash: hash,
				connectionId: credential.connectionId,
				expiresAt: credential.expiresAt,
				modelIds: modelIds ?? undefined
			});
			return { status: 'connected' as const, modelIds };
		} catch (error) {
			await releaseChatGptLease(ctx, identity.subject, leaseId);
			throw error;
		}
	}
});

export const cancelChatGptDeviceLogin = action({
	args: { deviceAuthId: v.string(), userCode: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		const hash = await deviceAuthHash(args.deviceAuthId, args.userCode);
		const leaseId = crypto.randomUUID();
		await acquireChatGptLease(ctx, identity.subject, leaseId);
		try {
			const completed: boolean = await ctx.runQuery(
				internal.providerCredentials.isCompletedChatGptDeviceLogin,
				{ userId: identity.subject, hash, leaseId }
			);
			if (completed) {
				await deleteVaultObject(
					await credentialName(CHATGPT_CREDENTIAL_NAME_PREFIX, identity.subject)
				);
			}
			await ctx.runMutation(internal.providerCredentials.cancelChatGptDeviceLoginState, {
				userId: identity.subject,
				hash,
				leaseId
			});
			return null;
		} catch (error) {
			await releaseChatGptLease(ctx, identity.subject, leaseId);
			throw error;
		}
	}
});

export const refreshChatGptModels = action({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Authentication required.');
		const leaseId = crypto.randomUUID();
		await acquireChatGptLease(ctx, identity.subject, leaseId);
		try {
			const credential = await resolveChatGptCredentialWithLease(ctx, identity.subject, leaseId);
			const modelIds = await chatGptModelIds(credential);
			if (modelIds === null) throw new Error('Couldn’t load your ChatGPT models. Try again.');
			await ctx.runMutation(internal.providerCredentials.recordChatGptModels, {
				userId: identity.subject,
				leaseId,
				expiresAt: credential.expiresAt,
				modelIds
			});
			return modelIds;
		} catch (error) {
			await releaseChatGptLease(ctx, identity.subject, leaseId);
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
			await releaseChatGptLease(ctx, identity.subject, leaseId);
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
		const state = await chatGptState(ctx, args.userId);
		return state ? { expiresAt: state.expiresAt, modelIds: state.modelIds } : null;
	}
});

export const registerChatGptBrowserLogin = internalMutation({
	args: { userId: v.string(), hash: v.string(), verifier: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.refreshLeaseId && (state.refreshLeaseExpiresAt ?? 0) > Date.now()) {
			throw new Error('ChatGPT credentials are busy. Try again shortly.');
		}
		const fields = {
			browserAuthHash: args.hash,
			browserCodeVerifier: args.verifier,
			browserAuthExpiresAt: args.expiresAt,
			completedBrowserAuthHash: undefined,
			updatedAt: Date.now()
		};
		if (state) await ctx.db.patch(state._id, fields);
		else {
			await ctx.db.insert('providerCredentialStates', {
				...fields,
				userId: args.userId,
				provider: 'chatgpt',
				expiresAt: 0
			});
		}
		return null;
	}
});

export const authorizeChatGptBrowserLogin = internalQuery({
	args: { userId: v.string(), hash: v.string() },
	returns: v.string(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (
			state?.browserAuthHash !== args.hash ||
			(state.browserAuthExpiresAt ?? 0) <= Date.now() ||
			!state.browserCodeVerifier
		) {
			throw new Error('ChatGPT sign-in expired or was cancelled. Start again.');
		}
		return state.browserCodeVerifier;
	}
});

export const cancelChatGptBrowserLoginState = internalMutation({
	args: { userId: v.string(), hash: v.string(), leaseId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.refreshLeaseId !== args.leaseId) {
			throw new Error('ChatGPT credential update lost its lease.');
		}
		const completed = state.completedBrowserAuthHash === args.hash;
		await ctx.db.patch(state._id, {
			browserAuthHash: state.browserAuthHash === args.hash ? undefined : state.browserAuthHash,
			browserAuthExpiresAt:
				state.browserAuthHash === args.hash ? undefined : state.browserAuthExpiresAt,
			browserCodeVerifier:
				state.browserAuthHash === args.hash ? undefined : state.browserCodeVerifier,
			completedBrowserAuthHash: completed ? undefined : state.completedBrowserAuthHash,
			connectionId: completed ? undefined : state.connectionId,
			expiresAt: completed ? 0 : state.expiresAt,
			modelIds: completed ? undefined : state.modelIds,
			refreshLeaseId: undefined,
			refreshLeaseExpiresAt: undefined,
			updatedAt: Date.now()
		});
		return null;
	}
});

export const isCompletedChatGptBrowserLogin = internalQuery({
	args: { userId: v.string(), hash: v.string(), leaseId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		return state?.refreshLeaseId === args.leaseId && state.completedBrowserAuthHash === args.hash;
	}
});

export const recordChatGptBrowserCredential = internalMutation({
	args: {
		userId: v.string(),
		leaseId: v.string(),
		hash: v.string(),
		connectionId: v.string(),
		expiresAt: v.number(),
		modelIds: v.optional(v.array(v.string()))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.refreshLeaseId !== args.leaseId || state.browserAuthHash !== args.hash) {
			throw new Error('ChatGPT credential update lost its lease.');
		}
		await ctx.db.patch(state._id, {
			expiresAt: args.expiresAt,
			modelIds: args.modelIds,
			browserAuthHash: undefined,
			browserAuthExpiresAt: undefined,
			browserCodeVerifier: undefined,
			completedBrowserAuthHash: args.hash,
			completedDeviceAuthHash: undefined,
			connectionId: args.connectionId,
			refreshLeaseId: undefined,
			refreshLeaseExpiresAt: undefined,
			updatedAt: Date.now()
		});
		return null;
	}
});

export const registerChatGptDeviceLogin = internalMutation({
	args: { userId: v.string(), hash: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.refreshLeaseId && (state.refreshLeaseExpiresAt ?? 0) > Date.now()) {
			throw new Error('ChatGPT credentials are busy. Try again shortly.');
		}
		const fields = {
			deviceAuthHash: args.hash,
			deviceAuthExpiresAt: args.expiresAt,
			completedDeviceAuthHash: undefined,
			updatedAt: Date.now()
		};
		if (state) {
			await ctx.db.patch(state._id, fields);
		} else {
			await ctx.db.insert('providerCredentialStates', {
				...fields,
				userId: args.userId,
				provider: 'chatgpt',
				expiresAt: 0
			});
		}
		return null;
	}
});

export const recordChatGptModels = internalMutation({
	args: {
		userId: v.string(),
		leaseId: v.string(),
		expiresAt: v.number(),
		modelIds: v.array(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.refreshLeaseId !== args.leaseId) {
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

export const authorizeChatGptDeviceLogin = internalQuery({
	args: { userId: v.string(), hash: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.deviceAuthHash !== args.hash || (state.deviceAuthExpiresAt ?? 0) <= Date.now()) {
			throw new Error('ChatGPT sign-in expired or was cancelled. Start again.');
		}
		return null;
	}
});

export const isCompletedChatGptDeviceLogin = internalQuery({
	args: { userId: v.string(), hash: v.string(), leaseId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		return state?.refreshLeaseId === args.leaseId && state.completedDeviceAuthHash === args.hash;
	}
});

export const cancelChatGptDeviceLoginState = internalMutation({
	args: { userId: v.string(), hash: v.string(), leaseId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (state?.refreshLeaseId !== args.leaseId) {
			throw new Error('ChatGPT credential update lost its lease.');
		}
		if (state.completedDeviceAuthHash === args.hash) {
			await ctx.db.patch(state._id, {
				completedDeviceAuthHash: undefined,
				connectionId: undefined,
				expiresAt: 0,
				modelIds: undefined,
				refreshLeaseId: undefined,
				refreshLeaseExpiresAt: undefined,
				updatedAt: Date.now()
			});
		} else {
			await ctx.db.patch(state._id, {
				deviceAuthHash: state.deviceAuthHash === args.hash ? undefined : state.deviceAuthHash,
				deviceAuthExpiresAt:
					state.deviceAuthHash === args.hash ? undefined : state.deviceAuthExpiresAt,
				refreshLeaseId: undefined,
				refreshLeaseExpiresAt: undefined,
				updatedAt: Date.now()
			});
		}
		return null;
	}
});

export const acquireChatGptCredentialLease = internalMutation({
	args: { userId: v.string(), leaseId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const state = await chatGptState(ctx, args.userId);
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
		const state = await chatGptState(ctx, args.userId);
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
		const state = await chatGptState(ctx, args.userId);
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
		deviceAuthHash: v.string(),
		connectionId: v.string(),
		expiresAt: v.number(),
		modelIds: v.optional(v.array(v.string()))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await chatGptState(ctx, args.userId);
		if (
			!state ||
			state.refreshLeaseId !== args.leaseId ||
			state.deviceAuthHash !== args.deviceAuthHash ||
			(state.deviceAuthExpiresAt ?? 0) <= Date.now()
		) {
			throw new Error('ChatGPT credential update lost its lease.');
		}
		await ctx.db.patch(state._id, {
			expiresAt: args.expiresAt,
			modelIds: args.modelIds,
			deviceAuthHash: undefined,
			deviceAuthExpiresAt: undefined,
			completedDeviceAuthHash: args.deviceAuthHash,
			completedBrowserAuthHash: undefined,
			connectionId: args.connectionId,
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
		const state = await chatGptState(ctx, args.userId);
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

export const chatGptConnection = query({
	args: { runId: v.id('runs'), executionSecret: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
		if (run.completionProvider !== 'chatgpt') {
			throw new Error('Run is not configured to use ChatGPT.');
		}
		return (await chatGptState(ctx, run.userId))?.connectionId ?? null;
	}
});

export const authorizeChatGptCredential = internalQuery({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.object({ userId: v.string(), connectionId: v.string() }),
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
		const connectionId = (await chatGptState(ctx, run.userId))?.connectionId;
		if (!connectionId) throw new Error('ChatGPT is no longer connected. Reconnect in Settings.');
		return { userId: run.userId, connectionId };
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
		connectionId: v.string(),
		accountId: v.string(),
		residency: v.optional(v.string()),
		expiresAt: v.number()
	}),
	handler: async (ctx, args) => {
		const connection: { userId: string; connectionId: string } = await ctx.runQuery(
			internal.providerCredentials.authorizeChatGptCredential,
			args
		);
		const credential = await resolveChatGptCredential(ctx, connection.userId);
		const current: { userId: string; connectionId: string } = await ctx.runQuery(
			internal.providerCredentials.authorizeChatGptCredential,
			args
		);
		if (
			connection.connectionId !== credential.connectionId ||
			current.connectionId !== credential.connectionId
		) {
			throw new Error('ChatGPT connection changed during credential issuance. Start a new run.');
		}
		return {
			accessToken: credential.accessToken,
			connectionId: credential.connectionId,
			accountId: credential.accountId,
			residency: credential.residency,
			expiresAt: credential.expiresAt
		};
	}
});
