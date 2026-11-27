import {
	action,
	httpAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { ConvexError, v } from 'convex/values';
import { z } from 'zod';
import { getUserId } from '@convex/lib/auth';
import { requireMachineProcess } from '@convex/lib/machineRuns';
import {
	callbackUrl,
	cimdClientId,
	clientMetadataDocument,
	codeChallenge,
	discoverAuthorizationServer,
	discoverProtectedResource,
	MAX_CLIENT_ID_LENGTH,
	MAX_SECRET_LENGTH,
	publicHttpsUrl,
	randomToken,
	registerClient,
	requestTokens,
	secretAuthMethod,
	type AuthorizationServer,
	type OAuthClient
} from '@convex/lib/mcpOAuth';
import { tokenEndpointAuthMethods, vMcpToolPolicy } from '@convex/lib/validators';
import {
	credentialName,
	deleteVaultObject,
	readVaultObject,
	storeVaultObject,
	writeVaultObjectIfUnchanged,
	type VaultObject
} from '@convex/lib/workosVault';
import schema from '@convex/schema';

const MAX_SERVERS = 50;

const MAX_TOOL_POLICIES_PER_SERVER = 200;

const MAX_NAME_LENGTH = 80;

const MAX_TOOL_NAME_LENGTH = 256;

const MAX_HEADERS = 20;

const MAX_HEADER_VALUE_LENGTH = 8192;

const OAUTH_STATE_TTL_MS = 10 * 60_000;

const REFRESH_MARGIN_MS = 60_000;

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

const RESERVED_CONNECTOR_IDS = new Set(['github', 'vercel', 'kicad']);

const oauthCredentialSchema = z.object({
	type: z.literal('oauth'),
	accessToken: z.string(),
	refreshToken: z.string().optional(),
	expiresAt: z.number().optional(),
	scope: z.string().optional(),
	issuer: z.string(),
	tokenEndpoint: z.string(),
	resource: z.string(),
	clientId: z.string(),
	clientSecret: z.string().optional(),
	tokenEndpointAuthMethod: z.enum(tokenEndpointAuthMethods)
});

type OAuthCredential = z.infer<typeof oauthCredentialSchema>;

const headersCredentialSchema = z.object({
	type: z.literal('headers'),
	headers: z.record(z.string(), z.string())
});

const storedClientSchema = z.object({
	issuer: z.string(),
	clientId: z.string(),
	clientSecret: z.string().optional()
});

type StoredClient = z.infer<typeof storedClientSchema>;

function credentialVaultName(userId: string, connectorId: string): Promise<string> {
	return credentialName('sprocket-mcp-', `${userId}/${connectorId}`);
}

function pastedClientVaultName(userId: string, connectorId: string): Promise<string> {
	return credentialName('sprocket-mcp-client-', `${userId}/${connectorId}`);
}

function parseVaultJson<T>(object: VaultObject, schema: z.ZodType<T>): T {
	try {
		return schema.parse(JSON.parse(object.value));
	} catch {
		throw new ConvexError('WorkOS Vault returned an invalid connector credential.');
	}
}

function needsAuthError(server: Doc<'mcpServers'>): ConvexError<{ code: string; message: string }> {
	return new ConvexError({
		code: 'needs_auth',
		message: `${server.name} needs you to connect it again in Settings → Connectors.`
	});
}

async function findServer(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	connectorId: string
): Promise<Doc<'mcpServers'> | null> {
	return await ctx.db
		.query('mcpServers')
		.withIndex('by_userId_and_connectorId', (q) =>
			q.eq('userId', userId).eq('connectorId', connectorId)
		)
		.unique();
}

function serverPolicies(ctx: QueryCtx | MutationCtx, userId: string, connectorId: string) {
	return ctx.db
		.query('mcpToolPolicies')
		.withIndex('by_userId_and_connectorId_and_tool', (q) =>
			q.eq('userId', userId).eq('connectorId', connectorId)
		);
}

export const listMine = query({
	args: {},
	returns: v.array(
		schema.tables.mcpServers.validator.omit('userId').extend({
			createdAt: v.number(),
			policies: v.array(schema.tables.mcpToolPolicies.validator.pick('tool', 'policy'))
		})
	),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);

		const servers = await ctx.db
			.query('mcpServers')
			.withIndex('by_userId_and_connectorId', (q) => q.eq('userId', userId))
			.take(MAX_SERVERS);

		return await Promise.all(
			servers.map(async (server) => ({
				connectorId: server.connectorId,
				name: server.name,
				url: server.url,
				catalogId: server.catalogId,
				auth: server.auth,
				headerNames: server.headerNames,
				status: server.status,
				createdAt: server._creationTime,
				policies: (
					await serverPolicies(ctx, userId, server.connectorId).take(MAX_TOOL_POLICIES_PER_SERVER)
				).map(({ tool, policy }) => ({ tool, policy }))
			}))
		);
	}
});

function connectorSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 40)
		.replace(/^-+|-+$/g, '');

	return slug || 'mcp';
}

export const insertServer = internalMutation({
	args: schema.tables.mcpServers.validator.omit('connectorId').fields,
	returns: v.string(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('mcpServers')
			.withIndex('by_userId_and_connectorId', (q) => q.eq('userId', args.userId))
			.take(MAX_SERVERS);

		if (existing.length >= MAX_SERVERS) {
			throw new ConvexError(`Add at most ${MAX_SERVERS} remote MCP servers.`);
		}

		const taken = new Set([...RESERVED_CONNECTOR_IDS, ...existing.map((s) => s.connectorId)]);
		const base = connectorSlug(args.name);
		let connectorId = base;

		for (let suffix = 2; taken.has(connectorId); suffix++) connectorId = `${base}-${suffix}`;
		await ctx.db.insert('mcpServers', { ...args, connectorId });

		return connectorId;
	}
});

function validHeaders(headers: Record<string, string>): Record<string, string> {
	const entries = Object.entries(headers);

	if (entries.length > MAX_HEADERS) throw new ConvexError(`Add at most ${MAX_HEADERS} headers.`);

	for (const [name, value] of entries) {
		if (!HEADER_NAME_PATTERN.test(name))
			throw new ConvexError(`${name} isn't a valid header name.`);

		if (!value || value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/.test(value)) {
			throw new ConvexError(`Enter a valid value for the ${name} header.`);
		}
	}

	return headers;
}

export const add = action({
	args: {
		name: v.string(),
		url: v.string(),
		catalogId: v.optional(v.string()),
		headers: v.optional(v.record(v.string(), v.string()))
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const name = args.name.trim();

		if (!name || name.length > MAX_NAME_LENGTH) {
			throw new ConvexError(`Enter a name of at most ${MAX_NAME_LENGTH} characters.`);
		}

		if (args.catalogId !== undefined && !/^[\w.-]{1,128}$/.test(args.catalogId)) {
			throw new ConvexError('Invalid catalog ID.');
		}

		const url = publicHttpsUrl(args.url);
		url.hash = '';
		const headers = validHeaders(args.headers ?? {});
		const headerNames = Object.keys(headers);
		let auth: Doc<'mcpServers'>['auth'] = 'headers';

		if (headerNames.length === 0) auth = (await discoverProtectedResource(url)) ? 'oauth' : 'none';

		const connectorId: string = await ctx.runMutation(internal.mcpServers.insertServer, {
			userId,
			name,
			url: url.href,
			catalogId: args.catalogId,
			headerNames,
			auth,
			status: auth === 'oauth' ? 'needs_auth' : 'connected'
		});

		if (auth !== 'headers') return connectorId;

		try {
			await storeVaultObject(
				await credentialVaultName(userId, connectorId),
				JSON.stringify({ type: 'headers', headers }),
				null
			);
		} catch (error) {
			await ctx.runMutation(internal.mcpServers.deleteServer, { userId, connectorId });
			throw error;
		}

		return connectorId;
	}
});

export const deleteServer = internalMutation({
	args: { userId: v.string(), connectorId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId, connectorId }) => {
		const server = await findServer(ctx, userId, connectorId);

		if (server) await ctx.db.delete('mcpServers', server._id);

		for await (const policy of serverPolicies(ctx, userId, connectorId)) {
			await ctx.db.delete('mcpToolPolicies', policy._id);
		}

		return null;
	}
});

export const remove = action({
	args: { connectorId: v.string() },
	returns: v.null(),
	handler: async (ctx, { connectorId }) => {
		const userId = await getUserId(ctx);
		await deleteVaultObject(await credentialVaultName(userId, connectorId));
		await deleteVaultObject(await pastedClientVaultName(userId, connectorId));
		await ctx.runMutation(internal.mcpServers.deleteServer, { userId, connectorId });

		return null;
	}
});

export const setPolicy = mutation({
	args: { connectorId: v.string(), tool: v.string(), policy: vMcpToolPolicy },
	returns: v.null(),
	handler: async (ctx, { connectorId, tool, policy }) => {
		const userId = await getUserId(ctx);

		if (!(await findServer(ctx, userId, connectorId))) {
			throw new ConvexError('Connector not found.');
		}

		if (!tool || tool.length > MAX_TOOL_NAME_LENGTH) throw new ConvexError('Invalid tool name.');
		const saved = serverPolicies(ctx, userId, connectorId);
		const policies = await saved.take(MAX_TOOL_POLICIES_PER_SERVER);
		const existing = policies.find((entry) => entry.tool === tool);

		if (existing) {
			await ctx.db.patch('mcpToolPolicies', existing._id, { policy });
		} else if (policies.length >= MAX_TOOL_POLICIES_PER_SERVER) {
			throw new ConvexError(`Save policies for at most ${MAX_TOOL_POLICIES_PER_SERVER} tools.`);
		} else {
			await ctx.db.insert('mcpToolPolicies', { userId, connectorId, tool, policy });
		}

		return null;
	}
});

export const getServer = internalQuery({
	args: { userId: v.string(), connectorId: v.string() },
	handler: (ctx, { userId, connectorId }) => findServer(ctx, userId, connectorId)
});

export const getSharedClient = internalQuery({
	args: { issuer: v.string() },
	handler: (ctx, { issuer }) =>
		ctx.db
			.query('mcpOAuthClients')
			.withIndex('by_issuer', (q) => q.eq('issuer', issuer))
			.first()
});

export const saveSharedClient = internalMutation({
	args: schema.tables.mcpOAuthClients.validator.fields,
	handler: async (ctx, args) => {
		const winner = await ctx.db
			.query('mcpOAuthClients')
			.withIndex('by_issuer', (q) => q.eq('issuer', args.issuer))
			.first();

		if (winner) return winner;
		const id = await ctx.db.insert('mcpOAuthClients', args);

		return (await ctx.db.get('mcpOAuthClients', id))!;
	}
});

type SelectedClient = OAuthClient & { clientVaultName?: string };

function sharedClient(row: Doc<'mcpOAuthClients'>): SelectedClient {
	return {
		clientId: row.clientId,
		clientVaultName: row.clientVaultName,
		tokenEndpointAuthMethod: row.tokenEndpointAuthMethod
	};
}

async function registerSharedClient(
	ctx: ActionCtx,
	issuer: string,
	registrationEndpoint: string
): Promise<SelectedClient> {
	const existing: Doc<'mcpOAuthClients'> | null = await ctx.runQuery(
		internal.mcpServers.getSharedClient,
		{ issuer }
	);

	if (existing) return sharedClient(existing);
	const registered = await registerClient(registrationEndpoint);
	let clientVaultName: string | undefined;

	if (registered.clientSecret) {
		clientVaultName = await credentialName(
			'sprocket-mcp-dcr-',
			`${issuer}\n${registered.clientId}`
		);
		const stored: StoredClient = { issuer, ...registered };
		await storeVaultObject(clientVaultName, JSON.stringify(stored), null);
	}

	const winner: Doc<'mcpOAuthClients'> = await ctx.runMutation(
		internal.mcpServers.saveSharedClient,
		{
			issuer,
			clientId: registered.clientId,
			clientVaultName,
			tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod
		}
	);

	if (winner.clientId !== registered.clientId && clientVaultName) {
		await deleteVaultObject(clientVaultName);
	}

	return sharedClient(winner);
}

async function selectClient(
	ctx: ActionCtx,
	server: Doc<'mcpServers'>,
	authorizationServer: AuthorizationServer,
	pasted: { clientId: string; clientSecret?: string } | undefined
): Promise<SelectedClient> {
	const { issuer } = authorizationServer;
	const pastedName = await pastedClientVaultName(server.userId, server.connectorId);
	let stored: StoredClient | undefined;

	if (pasted) {
		const clientId = pasted.clientId.trim();
		const clientSecret = pasted.clientSecret?.trim() || undefined;

		if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH) {
			throw new ConvexError('Enter a valid client ID.');
		}

		if (clientSecret && clientSecret.length > MAX_SECRET_LENGTH) {
			throw new ConvexError('Enter a valid client secret.');
		}

		stored = { issuer, clientId, clientSecret };
		await storeVaultObject(pastedName, JSON.stringify(stored));
	} else {
		const object = await readVaultObject(pastedName);
		const saved = object && parseVaultJson(object, storedClientSchema);

		// Client IDs belong to the authorization server that issued them.
		if (saved?.issuer === issuer) stored = saved;
	}

	if (stored) {
		return stored.clientSecret
			? {
					clientId: stored.clientId,
					clientVaultName: pastedName,
					tokenEndpointAuthMethod: secretAuthMethod(authorizationServer)
				}
			: { clientId: stored.clientId, tokenEndpointAuthMethod: 'none' };
	}

	if (authorizationServer.client_id_metadata_document_supported) {
		return { clientId: cimdClientId(), tokenEndpointAuthMethod: 'none' };
	}

	if (authorizationServer.registration_endpoint) {
		return await registerSharedClient(ctx, issuer, authorizationServer.registration_endpoint);
	}

	throw new ConvexError({
		code: 'client_required',
		message: `${server.name} needs an OAuth client ID that you register with it.`
	});
}

export const insertOAuthState = internalMutation({
	args: schema.tables.mcpOAuthStates.validator.fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		const stateId = await ctx.db.insert('mcpOAuthStates', args);
		await ctx.scheduler.runAt(args.expiresAt, internal.mcpServers.expireOAuthState, { stateId });

		return null;
	}
});

export const expireOAuthState = internalMutation({
	args: { stateId: v.id('mcpOAuthStates') },
	returns: v.null(),
	handler: async (ctx, { stateId }) => {
		if (await ctx.db.get('mcpOAuthStates', stateId)) await ctx.db.delete('mcpOAuthStates', stateId);

		return null;
	}
});

export const startOAuth = action({
	args: {
		connectorId: v.string(),
		client: v.optional(v.object({ clientId: v.string(), clientSecret: v.optional(v.string()) }))
	},
	returns: v.object({ authorizationUrl: v.string() }),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);

		const server: Doc<'mcpServers'> | null = await ctx.runQuery(internal.mcpServers.getServer, {
			userId,
			connectorId: args.connectorId
		});

		if (!server) throw new ConvexError('Connector not found.');

		if (server.auth === 'headers')
			throw new ConvexError(`${server.name} uses headers, not sign-in.`);
		const resource = await discoverProtectedResource(new URL(server.url));

		if (!resource) throw new ConvexError(`${server.name} doesn't ask for sign-in.`);
		const authorizationServer = await discoverAuthorizationServer(resource.authorizationServer);
		const client = await selectClient(ctx, server, authorizationServer, args.client);
		const state = randomToken();
		const codeVerifier = randomToken();

		await ctx.runMutation(internal.mcpServers.insertOAuthState, {
			state,
			userId,
			connectorId: server.connectorId,
			codeVerifier,
			clientId: client.clientId,
			clientVaultName: client.clientVaultName,
			tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
			issuer: authorizationServer.issuer,
			issuerParameterRequired:
				authorizationServer.authorization_response_iss_parameter_supported === true,
			tokenEndpoint: authorizationServer.token_endpoint,
			resource: resource.resource,
			expiresAt: Date.now() + OAUTH_STATE_TTL_MS
		});

		const url = new URL(authorizationServer.authorization_endpoint);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', client.clientId);
		url.searchParams.set('redirect_uri', callbackUrl());
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', await codeChallenge(codeVerifier));
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('resource', resource.resource);
		const scopes = resource.scope?.split(' ').filter(Boolean) ?? [];

		if (
			scopes.length > 0 &&
			!scopes.includes('offline_access') &&
			authorizationServer.scopes_supported?.includes('offline_access')
		) {
			scopes.push('offline_access');
		}

		if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));

		return { authorizationUrl: url.href };
	}
});

export const consumeOAuthState = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, args) => {
		const pending = await ctx.db
			.query('mcpOAuthStates')
			.withIndex('by_state', (q) => q.eq('state', args.state))
			.unique();

		if (!pending) return null;
		await ctx.db.delete('mcpOAuthStates', pending._id);
		const server = await findServer(ctx, pending.userId, pending.connectorId);

		return pending.expiresAt > Date.now() && server ? { pending, serverName: server.name } : null;
	}
});

export const markAuthorized = internalMutation({
	args: { userId: v.string(), connectorId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { userId, connectorId }) => {
		const server = await findServer(ctx, userId, connectorId);

		if (!server) return false;
		await ctx.db.patch('mcpServers', server._id, { auth: 'oauth', status: 'connected' });

		return true;
	}
});

export const markNeedsAuth = internalMutation({
	args: { userId: v.string(), connectorId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId, connectorId }) => {
		const server = await findServer(ctx, userId, connectorId);

		if (server) await ctx.db.patch('mcpServers', server._id, { status: 'needs_auth' });

		return null;
	}
});

function expiresAt(expiresIn: number | undefined): number | undefined {
	return expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000;
}

async function completeAuthorization(
	ctx: ActionCtx,
	pending: Doc<'mcpOAuthStates'>,
	code: string
): Promise<void> {
	let clientSecret: string | undefined;

	if (pending.clientVaultName) {
		const object = await readVaultObject(pending.clientVaultName);
		const stored = object && parseVaultJson(object, storedClientSchema);

		if (stored?.clientId !== pending.clientId || stored.issuer !== pending.issuer) {
			throw new ConvexError('The OAuth client changed during sign-in.');
		}

		clientSecret = stored.clientSecret;
	}

	const client = {
		clientId: pending.clientId,
		clientSecret,
		tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod
	};

	const result = await requestTokens(pending.tokenEndpoint, client, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: callbackUrl(),
		code_verifier: pending.codeVerifier,
		resource: pending.resource
	});

	if (result.kind === 'error') {
		throw new ConvexError(`The authorization server rejected the sign-in (${result.error}).`);
	}

	const { tokens } = result;

	const credential: OAuthCredential = {
		type: 'oauth',
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: expiresAt(tokens.expires_in),
		scope: tokens.scope,
		issuer: pending.issuer,
		tokenEndpoint: pending.tokenEndpoint,
		resource: pending.resource,
		...client
	};

	const name = await credentialVaultName(pending.userId, pending.connectorId);
	await storeVaultObject(name, JSON.stringify(credential));

	const authorized: boolean = await ctx.runMutation(internal.mcpServers.markAuthorized, {
		userId: pending.userId,
		connectorId: pending.connectorId
	});

	if (!authorized) {
		await deleteVaultObject(name);
		throw new ConvexError('The connector was removed during sign-in.');
	}
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function callbackPage(status: number, message: string): Response {
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sprocket</title></head><body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem"><p>${escapeHtml(message)}</p></body></html>`;

	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer'
		}
	});
}

export const oauthCallback = httpAction(async (ctx, request) => {
	const params = new URL(request.url).searchParams;
	const state = params.get('state');
	const expired = 'This sign-in link expired or was already used. Connect again from Sprocket.';

	if (!state || state.length > 128) return callbackPage(400, expired);

	const consumed: { pending: Doc<'mcpOAuthStates'>; serverName: string } | null =
		await ctx.runMutation(internal.mcpServers.consumeOAuthState, { state });

	if (!consumed) return callbackPage(400, expired);
	const { pending, serverName } = consumed;
	const iss = params.get('iss');

	// RFC 9207: a missing or different issuer means the response may come from another server.
	if (iss === null ? pending.issuerParameterRequired : iss !== pending.issuer) {
		return callbackPage(400, 'The sign-in response came from an unexpected server.');
	}

	const code = params.get('code');

	if (!code) return callbackPage(400, `Signing in to ${serverName} was canceled or failed.`);

	try {
		await completeAuthorization(ctx, pending, code);
	} catch (error) {
		const reason = error instanceof ConvexError ? ` ${String(error.data)}` : '';

		return callbackPage(502, `Couldn't connect ${serverName}.${reason}`);
	}

	return callbackPage(200, `${serverName} is connected. You can close this window.`);
});

export const clientMetadata = httpAction(
	async () =>
		new Response(JSON.stringify(clientMetadataDocument()), {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
		})
);

export const authorizeMachine = internalQuery({
	args: {
		userId: v.string(),
		connectorId: v.string(),
		machineId: v.string(),
		processId: v.string()
	},
	handler: async (ctx, args) => {
		await requireMachineProcess(ctx, args.userId, args.machineId, args.processId);
		const server = await findServer(ctx, args.userId, args.connectorId);

		if (!server) throw new ConvexError('Connector not found.');

		return server;
	}
});

function isFresh(credential: OAuthCredential): boolean {
	return (
		credential.expiresAt === undefined || credential.expiresAt - REFRESH_MARGIN_MS > Date.now()
	);
}

/**
 * Refreshes under WorkOS Vault's version check. A refresh that loses the race, or whose rotated
 * refresh token was already spent, uses the token that the winning refresh stored.
 */
async function freshOAuthCredential(
	ctx: ActionCtx,
	server: Doc<'mcpServers'>,
	forceRefresh: boolean
): Promise<OAuthCredential> {
	const name = await credentialVaultName(server.userId, server.connectorId);
	let object = await readVaultObject(name);
	let refresh = forceRefresh;
	const owner = { userId: server.userId, connectorId: server.connectorId };

	for (let attempt = 0; attempt < 3 && object; attempt++) {
		const credential = parseVaultJson(object, oauthCredentialSchema);

		if (!refresh && isFresh(credential)) return credential;

		if (!credential.refreshToken) {
			await ctx.runMutation(internal.mcpServers.markNeedsAuth, owner);
			throw needsAuthError(server);
		}

		const result = await requestTokens(credential.tokenEndpoint, credential, {
			grant_type: 'refresh_token',
			refresh_token: credential.refreshToken,
			resource: credential.resource
		});

		if (result.kind === 'tokens') {
			const { tokens } = result;

			const refreshed: OAuthCredential = {
				...credential,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token ?? credential.refreshToken,
				expiresAt: expiresAt(tokens.expires_in),
				scope: tokens.scope ?? credential.scope
			};

			const write = await writeVaultObjectIfUnchanged(name, JSON.stringify(refreshed), object);

			if (write === 'written') return refreshed;
		}

		const latest = await readVaultObject(name);

		if (result.kind === 'error' && latest?.metadata.version_id === object.metadata.version_id) {
			if (result.error === 'invalid_grant') {
				await ctx.runMutation(internal.mcpServers.markNeedsAuth, owner);
				throw needsAuthError(server);
			}

			throw new ConvexError(`${server.name} refused to refresh its token (${result.error}).`);
		}

		object = latest;
		refresh = false;
	}

	if (!object) {
		await ctx.runMutation(internal.mcpServers.markNeedsAuth, owner);
		throw needsAuthError(server);
	}

	throw new ConvexError(`Couldn't refresh the token of ${server.name}. Try again in a moment.`);
}

export const issueCredential = action({
	args: {
		connectorId: v.string(),
		machineId: v.string(),
		processId: v.string(),
		forceRefresh: v.optional(v.boolean())
	},
	returns: v.object({
		headers: v.record(v.string(), v.string()),
		expiresAt: v.optional(v.number())
	}),
	handler: async (ctx, args) => {
		const server: Doc<'mcpServers'> = await ctx.runQuery(internal.mcpServers.authorizeMachine, {
			userId: await getUserId(ctx),
			connectorId: args.connectorId,
			machineId: args.machineId,
			processId: args.processId
		});

		if (server.auth === 'none') return { headers: {} };

		if (server.auth === 'oauth') {
			if (server.status === 'needs_auth') throw needsAuthError(server);
			const credential = await freshOAuthCredential(ctx, server, args.forceRefresh ?? false);

			return {
				headers: { Authorization: `Bearer ${credential.accessToken}` },
				expiresAt: credential.expiresAt
			};
		}

		const name = await credentialVaultName(server.userId, server.connectorId);
		const object = await readVaultObject(name);

		if (!object) {
			throw new ConvexError(`${server.name} has no saved headers. Add it again.`);
		}

		return { headers: parseVaultJson(object, headersCredentialSchema).headers };
	}
});
