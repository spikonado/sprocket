import { WorkOS } from '@workos-inc/node';
import { z } from 'zod';
import { hostedLoginFailureFromExchange, type HostedLoginFailure } from '$lib/hosted-login';

export const HOSTED_SESSION_COOKIE = '__Host-sprocket-session';
export const HOSTED_LOGIN_COOKIE = '__Host-sprocket-pkce';
export const HOSTED_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
export const HOSTED_LOGIN_MAX_AGE_SECONDS = 10 * 60;
export const HOSTED_CALLBACK_PATH = '/api/auth/callback';
export const TRANSIENT_HOSTED_AUTH_ERROR = 'Hosted sign-in is temporarily unavailable. Try again.';

export type HostedAuthUser = {
	id: string;
	email: string;
	firstName: string | null;
	lastName: string | null;
	profilePictureUrl: string | null;
};

export type HostedAuthEnv = {
	apiKey: string;
	clientId: string;
	cookiePassword: string;
	redirectUri: string | undefined;
};

export type HostedCookieOptions = {
	path: '/';
	httpOnly: true;
	secure: true;
	sameSite: 'lax';
	maxAge: number;
};

export const hostedCookieDelete = {
	path: '/' as const,
	secure: true as const
};

const hostedTokenRequestSchema = z.object({
	forceRefreshToken: z.boolean().optional()
});

export type HostedAuthenticateView =
	| { kind: 'valid'; accessToken: string; user: HostedAuthUser }
	| { kind: 'expired' }
	| { kind: 'missing' }
	| { kind: 'invalid' }
	| { kind: 'transient'; error: string };

export type HostedTokenDecision =
	| { action: 'respond'; accessToken: string; user: HostedAuthUser }
	| { action: 'refresh' }
	| { action: 'signedOut' }
	| { action: 'transient'; error: string };

export type HostedTokenResult =
	| { kind: 'session'; accessToken: string; user: HostedAuthUser; sealedSession?: string }
	| { kind: 'signedOut' }
	| { kind: 'transient'; error: string };

const loginStateSchema = z.object({
	state: z.string().min(1),
	codeVerifier: z.string().min(1)
});

const cookieUserSchema = z.object({
	id: z.string().min(1),
	email: z.email(),
	firstName: z.string().nullable().optional(),
	lastName: z.string().nullable().optional(),
	profilePictureUrl: z.string().nullable().optional()
});

export function readHostedAuthEnv(env: Record<string, string | undefined>): HostedAuthEnv {
	const apiKey = env.WORKOS_API_KEY?.trim() ?? '';
	const clientId = env.WORKOS_CLIENT_ID?.trim() ?? '';
	const cookiePassword = env.WORKOS_COOKIE_PASSWORD?.trim() ?? '';
	const redirectUri = env.WORKOS_REDIRECT_URI?.trim() || undefined;
	if (!apiKey || !clientId || cookiePassword.length < 32) {
		throw new Error('Hosted WorkOS authentication is not configured.');
	}
	return { apiKey, clientId, cookiePassword, redirectUri };
}

export function resolveRedirectUri(env: HostedAuthEnv, origin: string): string {
	return env.redirectUri ?? `${origin}${HOSTED_CALLBACK_PATH}`;
}

export function createHostedWorkOS(env: HostedAuthEnv): WorkOS {
	return new WorkOS(env.apiKey, { clientId: env.clientId });
}

function hostOnlyCookie(maxAge: number): HostedCookieOptions {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge
	};
}

export function sessionCookieOptions(): HostedCookieOptions {
	return hostOnlyCookie(HOSTED_SESSION_MAX_AGE_SECONDS);
}

export function loginCookieOptions(): HostedCookieOptions {
	return hostOnlyCookie(HOSTED_LOGIN_MAX_AGE_SECONDS);
}

export function hostedSameOrigin(originHeader: string | null, urlOrigin: string): boolean {
	return originHeader === urlOrigin;
}

export function parseHostedTokenJson(
	raw: string
): { ok: true; forceRefreshToken: boolean } | { ok: false } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false };
	}
	const parsed = hostedTokenRequestSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false };
	}
	return { ok: true, forceRefreshToken: parsed.data.forceRefreshToken ?? false };
}

export function serializeLoginState(state: { state: string; codeVerifier: string }): string {
	return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function parseLoginState(
	value: string | undefined
): { state: string; codeVerifier: string } | null {
	if (!value) {
		return null;
	}
	try {
		const parsed = loginStateSchema.safeParse(
			JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function toHostedAuthUser(user: {
	id: string;
	email: string;
	firstName?: string | null;
	lastName?: string | null;
	profilePictureUrl?: string | null;
}): HostedAuthUser {
	return {
		id: user.id,
		email: user.email,
		firstName: user.firstName ?? null,
		lastName: user.lastName ?? null,
		profilePictureUrl: user.profilePictureUrl ?? null
	};
}

export function hostedAuthenticateFromCookieResult(result: {
	authenticated: boolean;
	reason?: string;
	accessToken?: string;
	user?: unknown;
}): HostedAuthenticateView {
	if (result.authenticated) {
		const user = cookieUserSchema.safeParse(result.user);
		if (result.accessToken && user.success) {
			return {
				kind: 'valid',
				accessToken: result.accessToken,
				user: toHostedAuthUser(user.data)
			};
		}
		return { kind: 'invalid' };
	}
	if (result.reason === 'invalid_jwt') {
		return { kind: 'expired' };
	}
	if (result.reason === 'no_session_cookie_provided') {
		return { kind: 'missing' };
	}
	return { kind: 'invalid' };
}

export function hostedRefreshFromCookieResult(result: {
	authenticated: boolean;
	retryable?: boolean;
	reason?: string;
	sealedSession?: string;
	session?: { accessToken?: string; user?: unknown };
	user?: unknown;
}): HostedTokenResult {
	if (result.authenticated) {
		const accessToken = result.session?.accessToken;
		const user = cookieUserSchema.safeParse(result.session?.user ?? result.user);
		if (!accessToken || !result.sealedSession || !user.success) {
			return { kind: 'signedOut' };
		}
		return {
			kind: 'session',
			accessToken,
			user: toHostedAuthUser(user.data),
			sealedSession: result.sealedSession
		};
	}
	if (result.retryable) {
		return {
			kind: 'transient',
			error:
				result.reason === 'rate_limit_exceeded'
					? 'Hosted sign-in is rate limited. Try again.'
					: TRANSIENT_HOSTED_AUTH_ERROR
		};
	}
	return { kind: 'signedOut' };
}

export function decideHostedTokenAction(
	authenticate: HostedAuthenticateView,
	forceRefreshToken: boolean
): HostedTokenDecision {
	switch (authenticate.kind) {
		case 'transient':
			return { action: 'transient', error: authenticate.error };
		case 'missing':
		case 'invalid':
			return { action: 'signedOut' };
		case 'expired':
			return { action: 'refresh' };
		case 'valid':
			if (forceRefreshToken) {
				return { action: 'refresh' };
			}
			return {
				action: 'respond',
				accessToken: authenticate.accessToken,
				user: authenticate.user
			};
	}
}

type HostedTokenResponse = {
	status: number;
	body: { accessToken: string; user: HostedAuthUser } | { error: string } | null;
	clearSession: boolean;
	sealedSession?: string;
};

export function hostedTokenJson(result: HostedTokenResult): HostedTokenResponse {
	switch (result.kind) {
		case 'session':
			return {
				status: 200,
				body: { accessToken: result.accessToken, user: result.user },
				clearSession: false,
				sealedSession: result.sealedSession
			};
		case 'signedOut':
			return { status: 200, body: null, clearSession: true };
		case 'transient':
			return { status: 503, body: { error: result.error }, clearSession: false };
	}
}

export function hostedAuthJsonHeaders(): HeadersInit {
	return {
		'content-type': 'application/json',
		'cache-control': 'no-store'
	};
}

export type HostedWorkOS = {
	userManagement: {
		getAuthorizationUrlWithPKCE: WorkOS['userManagement']['getAuthorizationUrlWithPKCE'];
		authenticateWithCode: WorkOS['userManagement']['authenticateWithCode'];
		loadSealedSession: WorkOS['userManagement']['loadSealedSession'];
		revokeSession: WorkOS['userManagement']['revokeSession'];
	};
};

export async function issueHostedAuthorization(
	workos: HostedWorkOS,
	args: { env: HostedAuthEnv; origin: string; screenHint: 'sign-in' | 'sign-up' }
): Promise<{ url: string; loginCookie: string }> {
	const { url, state, codeVerifier } = await workos.userManagement.getAuthorizationUrlWithPKCE({
		provider: 'authkit',
		redirectUri: resolveRedirectUri(args.env, args.origin),
		screenHint: args.screenHint
	});
	return {
		url,
		loginCookie: serializeLoginState({ state, codeVerifier })
	};
}

export async function exchangeHostedAuthorizationCode(
	workos: HostedWorkOS,
	args: {
		env: HostedAuthEnv;
		code: string;
		state: string;
		loginCookie: string | undefined;
	}
): Promise<{ sealedSession: string } | { error: HostedLoginFailure }> {
	const login = parseLoginState(args.loginCookie);
	if (!login || login.state !== args.state) {
		return { error: hostedLoginFailureFromExchange('invalid_state') };
	}

	try {
		const authenticated = await workos.userManagement.authenticateWithCode({
			code: args.code,
			codeVerifier: login.codeVerifier,
			session: { sealSession: true, cookiePassword: args.env.cookiePassword }
		});
		if (!authenticated.sealedSession) {
			return { error: hostedLoginFailureFromExchange('missing_session') };
		}
		return { sealedSession: authenticated.sealedSession };
	} catch {
		return { error: 'failed' };
	}
}

export async function readHostedAccessToken(
	workos: HostedWorkOS,
	args: {
		env: HostedAuthEnv;
		sessionCookie: string | undefined;
		forceRefreshToken: boolean;
	}
): Promise<HostedTokenResult> {
	if (!args.sessionCookie) {
		return { kind: 'signedOut' };
	}

	const session = workos.userManagement.loadSealedSession({
		sessionData: args.sessionCookie,
		cookiePassword: args.env.cookiePassword
	});

	let authenticate: HostedAuthenticateView;
	try {
		authenticate = hostedAuthenticateFromCookieResult(await session.authenticate());
	} catch {
		authenticate = {
			kind: 'transient',
			error: TRANSIENT_HOSTED_AUTH_ERROR
		};
	}

	const decision = decideHostedTokenAction(authenticate, args.forceRefreshToken);
	if (decision.action === 'respond') {
		return {
			kind: 'session',
			accessToken: decision.accessToken,
			user: decision.user
		};
	}
	if (decision.action === 'signedOut') {
		return { kind: 'signedOut' };
	}
	if (decision.action === 'transient') {
		return { kind: 'transient', error: decision.error };
	}

	try {
		return hostedRefreshFromCookieResult(await session.refresh());
	} catch {
		return {
			kind: 'transient',
			error: TRANSIENT_HOSTED_AUTH_ERROR
		};
	}
}

export async function revokeHostedSession(
	workos: HostedWorkOS,
	args: { env: HostedAuthEnv; sessionCookie: string | undefined }
): Promise<void> {
	if (!args.sessionCookie) {
		return;
	}
	try {
		const session = workos.userManagement.loadSealedSession({
			sessionData: args.sessionCookie,
			cookiePassword: args.env.cookiePassword
		});
		const authenticated = await session.authenticate();
		if (authenticated.authenticated) {
			await workos.userManagement.revokeSession({ sessionId: authenticated.sessionId });
		}
	} catch {
		return;
	}
}
