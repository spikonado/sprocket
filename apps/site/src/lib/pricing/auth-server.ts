import { WorkOS, type User } from '@workos-inc/node';
import type { AstroCookies, AstroCookieSetOptions } from 'astro';
import * as z from 'zod/mini';
import { isBillingInterval } from './catalog';

type Cookies = {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options: AstroCookieSetOptions): void;
	delete(name: string, options: Parameters<AstroCookies['delete']>[1]): void;
};

export type PricingAuthServer = { workos: WorkOS; cookiePassword: string };

export type PricingSession = {
	user: { id: string; email: string } | null;
	accessToken: string | null;
	expiresAt: number | null;
};

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const LOGIN_MAX_AGE = 10 * 60;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const signedOut: PricingSession = { user: null, accessToken: null, expiresAt: null };

const loginCookieSchema = z.object({
	state: z.string(),
	codeVerifier: z.string(),
	returnTo: z.string()
});

export class PricingAuthError extends Error {
	constructor(
		message: string,
		public status = 503
	) {
		super(message);
	}
}

export function createPricingAuthServer(
	apiKey: string | undefined,
	cookiePassword: string | undefined,
	clientId: string
): PricingAuthServer {
	if (!apiKey) throw new PricingAuthError('Sign-in is not configured (missing WORKOS_API_KEY).');

	if (!cookiePassword)
		throw new PricingAuthError('Sign-in is not configured (missing WORKOS_COOKIE_PASSWORD).');

	return {
		cookiePassword,
		workos: new WorkOS(apiKey, {
			clientId,
			issuer: ['https://api.workos.com/', `https://api.workos.com/user_management/${clientId}`],
			timeout: 8_000,
			maxRetries: 0
		})
	};
}

function cookie(url: URL, kind: 'session' | 'login') {
	const secure = url.protocol === 'https:';

	return {
		name: `${secure ? '__Host-' : ''}sprocket-pricing-${kind}`,
		options: { path: '/', httpOnly: true, secure, sameSite: 'lax' as const }
	};
}

function tokenClaims(token: string): { exp?: number; sid?: string } {
	return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
}

export async function beginPricingSignIn(
	server: PricingAuthServer,
	cookies: Cookies,
	url: URL
): Promise<string> {
	const tier = url.searchParams.get('tier');
	const interval = url.searchParams.get('interval');

	const returnTo =
		tier && isBillingInterval(interval)
			? `/pricing?${new URLSearchParams({ checkout: 'resume', tier, interval })}`
			: '/pricing';

	const login = await server.workos.userManagement.getAuthorizationUrlWithPKCE({
		provider: 'authkit',
		redirectUri: `${url.origin}/pricing/callback`
	});

	const { name, options } = cookie(url, 'login');
	cookies.set(
		name,
		JSON.stringify({ state: login.state, codeVerifier: login.codeVerifier, returnTo }),
		{ ...options, maxAge: LOGIN_MAX_AGE }
	);

	return login.url;
}

/** Returns the pricing path to continue on, carrying the plan chosen before sign-in. */
export async function completePricingSignIn(
	server: PricingAuthServer,
	cookies: Cookies,
	url: URL
): Promise<string> {
	const { name, options } = cookie(url, 'login');
	const login = readLoginCookie(cookies.get(name)?.value);
	cookies.delete(name, options);
	const code = url.searchParams.get('code');

	if (
		!code ||
		!login ||
		login.state !== url.searchParams.get('state') ||
		!login.returnTo.startsWith('/pricing')
	) {
		throw new PricingAuthError('Sign-in could not be completed.', 400);
	}

	const result = await server.workos.userManagement.authenticateWithCode({
		code,
		codeVerifier: login.codeVerifier,
		session: { sealSession: true, cookiePassword: server.cookiePassword }
	});

	if (!result.sealedSession) throw new PricingAuthError('Sign-in did not return a session.');
	writeSessionCookie(cookies, url, result.sealedSession);

	return login.returnTo;
}

function readLoginCookie(value: string | undefined): z.infer<typeof loginCookieSchema> | undefined {
	try {
		return loginCookieSchema.safeParse(JSON.parse(value ?? 'null')).data;
	} catch {
		return undefined;
	}
}

function writeSessionCookie(cookies: Cookies, url: URL, sealedSession: string): void {
	const { name, options } = cookie(url, 'session');
	cookies.set(name, sealedSession, { ...options, maxAge: SESSION_MAX_AGE });
}

function signedIn(user: User, accessToken: string): PricingSession & { expiresAt: number } {
	return {
		user: { id: user.id, email: user.email },
		accessToken,
		expiresAt: (tokenClaims(accessToken).exp ?? 0) * 1000
	};
}

export async function getPricingSession(
	server: PricingAuthServer,
	cookies: Cookies,
	url: URL
): Promise<PricingSession> {
	const { name, options } = cookie(url, 'session');
	const sealedSession = cookies.get(name)?.value;

	if (!sealedSession) return signedOut;

	const session = server.workos.userManagement.loadSealedSession({
		sessionData: sealedSession,
		cookiePassword: server.cookiePassword
	});

	const current = await session.authenticate();

	if (current.authenticated) {
		const valid = signedIn(current.user, current.accessToken);

		if (valid.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return valid;
	} else if (current.reason !== 'invalid_jwt') {
		cookies.delete(name, options);

		return signedOut;
	}

	const refreshed = await session.refresh();

	if (!refreshed.authenticated) {
		if (refreshed.retryable) throw new PricingAuthError('Sign-in is temporarily unavailable.');
		cookies.delete(name, options);

		return signedOut;
	}

	if (!refreshed.session || !refreshed.sealedSession)
		throw new PricingAuthError('Sign-in could not be refreshed.');
	writeSessionCookie(cookies, url, refreshed.sealedSession);

	return signedIn(refreshed.user, refreshed.session.accessToken);
}

/** Clears local pricing cookies and returns the sealed session that was in them. */
export function takePricingSession(cookies: Cookies, url: URL): string | undefined {
	const session = cookie(url, 'session');
	const login = cookie(url, 'login');
	const sealedSession = cookies.get(session.name)?.value;
	cookies.delete(session.name, session.options);
	cookies.delete(login.name, login.options);

	return sealedSession;
}

export async function pricingLogoutUrl(
	server: PricingAuthServer,
	sealedSession: string,
	url: URL
): Promise<string | null> {
	// Unsealing without verification still finds the session ID after the access token expires.
	const session = await server.workos.userManagement.getSessionFromCookie({
		sessionData: sealedSession,
		cookiePassword: server.cookiePassword
	});

	const sessionId = session?.accessToken && tokenClaims(session.accessToken).sid;

	if (!sessionId) return null;

	return server.workos.userManagement.getLogoutUrl({
		sessionId,
		returnTo: `${url.origin}/pricing`
	});
}

export function isSameOriginPost(request: Request): boolean {
	return request.headers.get('origin') === new URL(request.url).origin;
}

export function pricingAuthJson(
	body: PricingSession | { error: string } | { logoutUrl: string | null },
	status = 200
): Response {
	return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function pricingAuthFailure(cause: unknown): Response {
	return cause instanceof PricingAuthError
		? pricingAuthJson({ error: cause.message }, cause.status)
		: pricingAuthJson({ error: 'Sign-in is temporarily unavailable. Try again.' }, 503);
}
