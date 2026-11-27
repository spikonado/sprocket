import { env } from '@convex/_generated/server';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import type { TokenEndpointAuthMethod } from '@convex/lib/validators';
import { providerFetch, responseJson } from '@convex/lib/workosVault';

export const MCP_CALLBACK_PATH = '/oauth/mcp/callback';

export const MCP_CLIENT_METADATA_PATH = '/oauth/mcp/client-metadata.json';

const MAX_URL_LENGTH = 2048;

const MAX_REDIRECTS = 3;

export const MAX_CLIENT_ID_LENGTH = 2048;

export const MAX_SECRET_LENGTH = 16_384;

// Older servers reject newer versions in `initialize`; the probe only needs their 401.
const PROBE_PROTOCOL_VERSION = '2025-11-25';

export function cimdClientId(): string {
	return `${env.CONVEX_SITE_URL}${MCP_CLIENT_METADATA_PATH}`;
}

export function callbackUrl(): string {
	return `${env.CONVEX_SITE_URL}${MCP_CALLBACK_PATH}`;
}

function clientRegistration() {
	return {
		client_name: 'Sprocket',
		redirect_uris: [callbackUrl()],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none'
	};
}

export function clientMetadataDocument() {
	return { client_id: cimdClientId(), ...clientRegistration() };
}

function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split('.').map(Number);

	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
	const [a = 0, b = 0] = octets;

	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname.replace(/\.$/, '');

	if (host === 'localhost' || host.endsWith('.localhost')) return true;

	// Only global unicast (2000::/3) IPv6 literals are public. URL drops leading zeros, so those
	// always start with a four-digit group.
	if (host.startsWith('[')) return !/^\[[23][0-9a-f]{3}:/.test(host);

	return isPrivateIpv4(host);
}

/** Parses a URL that Convex may fetch or send a browser to: HTTPS on a public host. */
export function publicHttpsUrl(raw: string): URL {
	let url: URL;

	try {
		url = new URL(raw.trim());
	} catch {
		throw new ConvexError(`${raw} is not a valid URL.`);
	}

	if (
		raw.length > MAX_URL_LENGTH ||
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		isPrivateHost(url.hostname)
	) {
		throw new ConvexError(
			`${url.origin} isn't a public HTTPS server. Add servers that run on this machine as local connectors.`
		);
	}

	return url;
}

async function discard(response: Response): Promise<void> {
	await response.body?.cancel();
}

async function fetchPublic(url: URL, init: RequestInit = {}): Promise<Response> {
	let target = url;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let response: Response;

		try {
			response = await providerFetch(publicHttpsUrl(target.href), { ...init, redirect: 'manual' });
		} catch (error) {
			if (error instanceof ConvexError) throw error;
			throw new ConvexError(`Couldn't reach ${target.origin}.`);
		}

		const location = response.headers.get('location');

		if (response.status < 300 || response.status >= 400 || !location || init.method) {
			return response;
		}

		await discard(response);
		target = new URL(location, target);
	}

	throw new ConvexError(`${url.origin} redirected too many times.`);
}

async function fetchMetadata<T>(url: URL, schema: z.ZodType<T>): Promise<T | null> {
	const response = await fetchPublic(url, { headers: { accept: 'application/json' } });

	if (!response.ok) {
		await discard(response);

		return null;
	}

	try {
		return await responseJson(response, url.origin, schema);
	} catch {
		return null;
	}
}

const AUTH_PARAM_PATTERN = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;

function challengeParams(header: string | null): Map<string, string> {
	const params = new Map<string, string>();

	for (const match of header?.matchAll(AUTH_PARAM_PATTERN) ?? []) {
		const name = match[1]!.toLowerCase();

		if (!params.has(name)) params.set(name, (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'));
	}

	return params;
}

const protectedResourceSchema = z.object({
	resource: z.string(),
	authorization_servers: z.array(z.string()).min(1),
	scopes_supported: z.array(z.string()).optional()
});

type ProtectedResource = {
	resource: string;
	authorizationServer: string;
	scope?: string;
};

/** RFC 9728 allows metadata for an origin or path prefix to cover the server URL. */
function resourceCovers(resource: string, serverUrl: URL): boolean {
	let parsed: URL;

	try {
		parsed = new URL(resource);
	} catch {
		return false;
	}

	const base = parsed.pathname.replace(/\/+$/, '');

	return (
		parsed.origin === serverUrl.origin &&
		!parsed.hash &&
		(serverUrl.pathname === base || serverUrl.pathname.startsWith(`${base}/`))
	);
}

/**
 * Sends an unauthenticated request and, when the server answers 401, finds its protected resource
 * metadata. Returns `null` for a server that doesn't ask for authorization.
 */
export async function discoverProtectedResource(serverUrl: URL): Promise<ProtectedResource | null> {
	const response = await fetchPublic(serverUrl, {
		method: 'POST',
		headers: {
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: PROBE_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'Sprocket', version: '1.0.0' }
			}
		})
	});

	await discard(response);

	if (response.status >= 300 && response.status < 400) {
		throw new ConvexError(`${serverUrl.href} redirects. Add the URL it redirects to instead.`);
	}

	if (response.status !== 401) return null;
	const challenge = challengeParams(response.headers.get('www-authenticate'));
	const headerUrl = challenge.get('resource_metadata');
	const path = serverUrl.pathname.replace(/\/+$/, '');
	const wellKnown = `${serverUrl.origin}/.well-known/oauth-protected-resource`;

	const candidates = headerUrl
		? [publicHttpsUrl(new URL(headerUrl, serverUrl).href)]
		: [...(path ? [new URL(`${wellKnown}${path}`)] : []), new URL(wellKnown)];

	for (const candidate of candidates) {
		const metadata = await fetchMetadata(candidate, protectedResourceSchema);

		if (metadata && resourceCovers(metadata.resource, serverUrl)) {
			return {
				resource: metadata.resource,
				authorizationServer: metadata.authorization_servers[0]!,
				scope: challenge.get('scope') || metadata.scopes_supported?.join(' ') || undefined
			};
		}
	}

	throw new ConvexError(
		`${serverUrl.origin} requires authorization but doesn't publish OAuth metadata. Add it with the headers it needs instead.`
	);
}

const authorizationServerSchema = z.object({
	issuer: z.string(),
	authorization_endpoint: z.string(),
	token_endpoint: z.string(),
	registration_endpoint: z.string().optional(),
	scopes_supported: z.array(z.string()).optional(),
	code_challenge_methods_supported: z.array(z.string()).optional(),
	token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
	client_id_metadata_document_supported: z.boolean().optional(),
	authorization_response_iss_parameter_supported: z.boolean().optional()
});

export type AuthorizationServer = z.infer<typeof authorizationServerSchema>;

function authorizationServerMetadataUrls(issuer: URL): URL[] {
	const path = issuer.pathname.replace(/\/+$/, '');

	return [
		new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
		new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
		...(path ? [new URL(`${path}/.well-known/openid-configuration`, issuer.origin)] : [])
	];
}

export async function discoverAuthorizationServer(issuer: string): Promise<AuthorizationServer> {
	for (const candidate of authorizationServerMetadataUrls(publicHttpsUrl(issuer))) {
		const metadata = await fetchMetadata(candidate, authorizationServerSchema);

		// RFC 8414 section 3.3: metadata naming another issuer must not be used.
		if (!metadata || metadata.issuer !== issuer) continue;

		if (!metadata.code_challenge_methods_supported?.includes('S256')) {
			throw new ConvexError(`${issuer} doesn't support PKCE, so Sprocket can't sign in safely.`);
		}

		publicHttpsUrl(metadata.authorization_endpoint);
		publicHttpsUrl(metadata.token_endpoint);

		return metadata;
	}

	throw new ConvexError(`Couldn't find the OAuth metadata of ${issuer}.`);
}

export function secretAuthMethod(server: AuthorizationServer): TokenEndpointAuthMethod {
	const supported = server.token_endpoint_auth_methods_supported;

	return supported?.includes('client_secret_post') && !supported.includes('client_secret_basic')
		? 'client_secret_post'
		: 'client_secret_basic';
}

const registeredClientSchema = z.object({
	client_id: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
	client_secret: z.string().min(1).max(MAX_SECRET_LENGTH).optional(),
	token_endpoint_auth_method: z.string().optional()
});

export type OAuthClient = {
	clientId: string;
	clientSecret?: string;
	tokenEndpointAuthMethod: TokenEndpointAuthMethod;
};

export async function registerClient(registrationEndpoint: string): Promise<OAuthClient> {
	const url = publicHttpsUrl(registrationEndpoint);

	const response = await fetchPublic(url, {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify({ ...clientRegistration(), application_type: 'web' })
	});

	if (!response.ok) {
		await discard(response);
		throw new ConvexError(`${url.origin} refused to register Sprocket as an OAuth client.`);
	}

	const registered = await responseJson(response, url.origin, registeredClientSchema);

	if (!registered.client_secret) {
		return { clientId: registered.client_id, tokenEndpointAuthMethod: 'none' };
	}

	return {
		clientId: registered.client_id,
		clientSecret: registered.client_secret,
		tokenEndpointAuthMethod:
			registered.token_endpoint_auth_method === 'client_secret_post'
				? 'client_secret_post'
				: 'client_secret_basic'
	};
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

export function randomToken(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

	return base64Url(new Uint8Array(digest));
}

const tokenResponseSchema = z.object({
	access_token: z.string().min(1).max(MAX_SECRET_LENGTH),
	token_type: z
		.string()
		.refine((type) => type.toLowerCase() === 'bearer')
		.optional(),
	expires_in: z.number().positive().optional(),
	refresh_token: z.string().min(1).max(MAX_SECRET_LENGTH).optional(),
	scope: z.string().optional()
});

const tokenErrorSchema = z.object({ error: z.string() });

type TokenResult =
	| { kind: 'tokens'; tokens: z.infer<typeof tokenResponseSchema> }
	| { kind: 'error'; error: string };

export async function requestTokens(
	tokenEndpoint: string,
	client: OAuthClient,
	params: Record<string, string>
): Promise<TokenResult> {
	const url = publicHttpsUrl(tokenEndpoint);
	const body = new URLSearchParams(params);

	const headers = new Headers({
		accept: 'application/json',
		'content-type': 'application/x-www-form-urlencoded'
	});

	if (client.tokenEndpointAuthMethod === 'client_secret_basic' && client.clientSecret) {
		// RFC 6749 section 2.3.1 form-encodes both parts before Base64.
		const id = encodeURIComponent(client.clientId);
		const secret = encodeURIComponent(client.clientSecret);
		headers.set('authorization', `Basic ${btoa(`${id}:${secret}`)}`);
	} else {
		body.set('client_id', client.clientId);

		if (client.clientSecret) body.set('client_secret', client.clientSecret);
	}

	const response = await fetchPublic(url, { method: 'POST', headers, body });

	if (response.ok) {
		return {
			kind: 'tokens',
			tokens: await responseJson(response, url.origin, tokenResponseSchema)
		};
	}

	if (response.status === 400 || response.status === 401) {
		try {
			const { error } = await responseJson(response, url.origin, tokenErrorSchema);

			return { kind: 'error', error };
		} catch {
			return { kind: 'error', error: 'invalid_response' };
		}
	}

	await discard(response);
	throw new ConvexError(`${url.origin} couldn't issue a token. Try again in a moment.`);
}
