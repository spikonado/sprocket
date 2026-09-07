import { describe, expect, it, vi } from 'vitest';
import {
	HOSTED_CALLBACK_PATH,
	HOSTED_LOGIN_COOKIE,
	HOSTED_SESSION_COOKIE,
	TRANSIENT_HOSTED_AUTH_ERROR,
	createHostedWorkOS,
	decideHostedTokenAction,
	exchangeHostedAuthorizationCode,
	hostedAuthenticateFromCookieResult,
	hostedCookieDelete,
	hostedRefreshFromCookieResult,
	hostedSameOrigin,
	hostedTokenJson,
	issueHostedAuthorization,
	loginCookieOptions,
	parseHostedTokenJson,
	parseLoginState,
	readHostedAccessToken,
	readHostedAuthEnv,
	resolveRedirectUri,
	revokeHostedSession,
	serializeLoginState,
	sessionCookieOptions,
	toHostedAuthUser,
	type HostedWorkOS
} from './hosted-auth';

const env = {
	WORKOS_API_KEY: 'sk_test_hosted',
	WORKOS_CLIENT_ID: 'client_hosted',
	WORKOS_COOKIE_PASSWORD: 'cookie-password-32-characters-min',
	WORKOS_REDIRECT_URI: 'https://sprocket.spikonado.com/api/auth/callback'
};

const user = {
	id: 'user-a',
	email: 'a@example.com',
	firstName: 'Ada',
	lastName: null,
	profilePictureUrl: null
};

describe('readHostedAuthEnv', () => {
	it('requires an API key, client ID, and 32-character cookie password', () => {
		expect(readHostedAuthEnv(env)).toEqual({
			apiKey: 'sk_test_hosted',
			clientId: 'client_hosted',
			cookiePassword: 'cookie-password-32-characters-min',
			redirectUri: 'https://sprocket.spikonado.com/api/auth/callback'
		});
		expect(() => readHostedAuthEnv({ ...env, WORKOS_COOKIE_PASSWORD: 'too-short' })).toThrow(
			'Hosted WorkOS authentication is not configured.'
		);
		expect(() => readHostedAuthEnv({ ...env, WORKOS_API_KEY: '' })).toThrow(
			'Hosted WorkOS authentication is not configured.'
		);
	});
});

describe('hosted cookies and login state', () => {
	it('uses __Host- HttpOnly Secure host-only cookies and round-trips PKCE state', () => {
		expect(HOSTED_SESSION_COOKIE).toBe('__Host-sprocket-session');
		expect(HOSTED_LOGIN_COOKIE).toBe('__Host-sprocket-pkce');
		expect(sessionCookieOptions()).toEqual({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 400
		});
		expect(loginCookieOptions()).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
		expect(hostedCookieDelete).toEqual({ path: '/', secure: true });
		expect(sessionCookieOptions()).not.toHaveProperty('domain');
		const encoded = serializeLoginState({ state: 'state-1', codeVerifier: 'verifier-1' });
		expect(encoded).not.toContain('verifier-1');
		expect(parseLoginState(encoded)).toEqual({ state: 'state-1', codeVerifier: 'verifier-1' });
		expect(parseLoginState(undefined)).toBeNull();
		expect(parseLoginState('%%%')).toBeNull();
	});

	it('falls back to the request origin callback without a custom WorkOS API host', () => {
		const authEnv = readHostedAuthEnv({ ...env, WORKOS_REDIRECT_URI: undefined });
		expect(resolveRedirectUri(authEnv, 'https://sprocket.spikonado.com')).toBe(
			`https://sprocket.spikonado.com${HOSTED_CALLBACK_PATH}`
		);
		const workos = createHostedWorkOS(authEnv);
		expect(workos.baseURL).toBe('https://api.workos.com');
	});
});

describe('hosted token POST guards', () => {
	it('accepts only the exact request origin', () => {
		expect(
			hostedSameOrigin('https://sprocket.spikonado.com', 'https://sprocket.spikonado.com')
		).toBe(true);
		expect(hostedSameOrigin('https://evil.spikonado.com', 'https://sprocket.spikonado.com')).toBe(
			false
		);
		expect(hostedSameOrigin(null, 'https://sprocket.spikonado.com')).toBe(false);
		expect(hostedSameOrigin('', 'https://sprocket.spikonado.com')).toBe(false);
	});

	it('rejects malformed JSON instead of defaulting to a refresh', () => {
		expect(parseHostedTokenJson('')).toEqual({ ok: false });
		expect(parseHostedTokenJson('{')).toEqual({ ok: false });
		expect(parseHostedTokenJson('null')).toEqual({ ok: false });
		expect(parseHostedTokenJson('{"forceRefreshToken":"yes"}')).toEqual({ ok: false });
		expect(parseHostedTokenJson('{}')).toEqual({ ok: true, forceRefreshToken: false });
		expect(parseHostedTokenJson('{"forceRefreshToken":true}')).toEqual({
			ok: true,
			forceRefreshToken: true
		});
	});
});

describe('hosted token decisions', () => {
	it('returns a valid access token unless forceRefresh is requested', () => {
		const valid = hostedAuthenticateFromCookieResult({
			authenticated: true,
			accessToken: 'access-token',
			user
		});
		expect(decideHostedTokenAction(valid, false)).toEqual({
			action: 'respond',
			accessToken: 'access-token',
			user: toHostedAuthUser(user)
		});
		expect(decideHostedTokenAction(valid, true)).toEqual({ action: 'refresh' });
		expect(
			decideHostedTokenAction(
				hostedAuthenticateFromCookieResult({ authenticated: false, reason: 'invalid_jwt' }),
				false
			)
		).toEqual({ action: 'refresh' });
		expect(
			decideHostedTokenAction(
				hostedAuthenticateFromCookieResult({
					authenticated: false,
					reason: 'no_session_cookie_provided'
				}),
				false
			)
		).toEqual({ action: 'signedOut' });
	});

	it('keeps the session on retryable refresh and signs out on invalid_grant', () => {
		const rotated = hostedRefreshFromCookieResult({
			authenticated: true,
			sealedSession: 'sealed-2',
			session: { accessToken: 'next-token', user }
		});
		expect(rotated).toMatchObject({
			kind: 'session',
			accessToken: 'next-token',
			sealedSession: 'sealed-2'
		});
		expect(
			hostedTokenJson(
				hostedRefreshFromCookieResult({
					authenticated: false,
					retryable: true,
					reason: 'timeout'
				})
			)
		).toEqual({
			status: 503,
			body: { error: TRANSIENT_HOSTED_AUTH_ERROR },
			clearSession: false
		});
		expect(
			hostedRefreshFromCookieResult({
				authenticated: false,
				retryable: true,
				reason: 'rate_limit_exceeded'
			})
		).toEqual({
			kind: 'transient',
			error: 'Hosted sign-in is rate limited. Try again.'
		});
		expect(
			hostedTokenJson(
				hostedRefreshFromCookieResult({
					authenticated: false,
					retryable: false,
					reason: 'invalid_grant'
				})
			)
		).toEqual({ status: 200, body: null, clearSession: true });
	});

	it('never puts the access token on the cookie helper result shape used by the UI store', () => {
		const json = hostedTokenJson({
			kind: 'session',
			accessToken: 'access-token',
			user: toHostedAuthUser(user)
		});
		expect(json.body).toEqual({
			accessToken: 'access-token',
			user: toHostedAuthUser(user)
		});
		expect(json.body).not.toHaveProperty('refreshToken');
	});
});

describe('hosted WorkOS session operations', () => {
	it('stores PKCE on the login cookie and rejects a mismatched callback state', async () => {
		const workos = fakeWorkOS({
			authorization: {
				url: 'https://api.workos.com/user_management/authorize?client_id=client_hosted',
				state: 'state-1',
				codeVerifier: 'verifier-1'
			}
		});
		const started = await issueHostedAuthorization(workos, {
			env: readHostedAuthEnv(env),
			origin: 'https://sprocket.spikonado.com',
			screenHint: 'sign-in'
		});
		expect(started.url).toContain('user_management/authorize');
		expect(
			await exchangeHostedAuthorizationCode(workos, {
				env: readHostedAuthEnv(env),
				code: 'code-1',
				state: 'attacker-state',
				loginCookie: started.loginCookie
			})
		).toEqual({ error: 'expired' });
		expect(
			await exchangeHostedAuthorizationCode(workos, {
				env: readHostedAuthEnv(env),
				code: 'code-1',
				state: 'state-1',
				loginCookie: started.loginCookie
			})
		).toEqual({ sealedSession: 'sealed-session' });
		expect(workos.authenticateWithCode).toHaveBeenCalledWith({
			code: 'code-1',
			codeVerifier: 'verifier-1',
			session: {
				sealSession: true,
				cookiePassword: env.WORKOS_COOKIE_PASSWORD
			}
		});
	});

	it('maps missing sealed sessions and SDK throws to a failed login without exception text', async () => {
		const workos = fakeWorkOS({
			authorization: {
				url: 'https://api.workos.com/user_management/authorize',
				state: 'state-1',
				codeVerifier: 'verifier-1'
			}
		});
		const started = await issueHostedAuthorization(workos, {
			env: readHostedAuthEnv(env),
			origin: 'https://sprocket.spikonado.com',
			screenHint: 'sign-in'
		});
		workos.authenticateWithCode.mockResolvedValueOnce({
			sealedSession: '',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			user
		});
		expect(
			await exchangeHostedAuthorizationCode(workos, {
				env: readHostedAuthEnv(env),
				code: 'code-1',
				state: 'state-1',
				loginCookie: started.loginCookie
			})
		).toEqual({ error: 'failed' });

		workos.authenticateWithCode.mockRejectedValueOnce(
			new Error('invalid_grant: sk_live_leaked_secret')
		);
		await expect(
			exchangeHostedAuthorizationCode(workos, {
				env: readHostedAuthEnv(env),
				code: 'code-1',
				state: 'state-1',
				loginCookie: started.loginCookie
			})
		).resolves.toEqual({ error: 'failed' });
	});

	it('returns a short-lived token, rotates on forceRefresh, and keeps the cookie on transient refresh', async () => {
		const workos = fakeWorkOS({
			authenticate: { authenticated: true, accessToken: 'access-token', user },
			refresh: {
				authenticated: true,
				sealedSession: 'sealed-2',
				session: { accessToken: 'rotated-token', user }
			}
		});
		const cached = await readHostedAccessToken(workos, {
			env: readHostedAuthEnv(env),
			sessionCookie: 'sealed-1',
			forceRefreshToken: false
		});
		expect(cached).toMatchObject({ kind: 'session', accessToken: 'access-token' });
		expect(workos.refresh).not.toHaveBeenCalled();

		const rotated = await readHostedAccessToken(workos, {
			env: readHostedAuthEnv(env),
			sessionCookie: 'sealed-1',
			forceRefreshToken: true
		});
		expect(rotated).toMatchObject({
			kind: 'session',
			accessToken: 'rotated-token',
			sealedSession: 'sealed-2'
		});

		workos.refresh.mockResolvedValue({
			authenticated: false,
			retryable: true,
			reason: 'server_error'
		});
		await expect(
			readHostedAccessToken(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1',
				forceRefreshToken: true
			})
		).resolves.toEqual({
			kind: 'transient',
			error: TRANSIENT_HOSTED_AUTH_ERROR
		});
	});

	it('does not surface SDK exception text from authenticate or refresh', async () => {
		const workos = fakeWorkOS({
			authenticate: { authenticated: true, accessToken: 'access-token', user }
		});
		workos.authenticate.mockRejectedValueOnce(new Error('sk_live_leaked_secret invalid_grant'));
		await expect(
			readHostedAccessToken(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1',
				forceRefreshToken: false
			})
		).resolves.toEqual({
			kind: 'transient',
			error: TRANSIENT_HOSTED_AUTH_ERROR
		});

		const refreshWorkos = fakeWorkOS({
			authenticate: { authenticated: false, reason: 'invalid_jwt' }
		});
		refreshWorkos.refresh.mockRejectedValueOnce(new Error('refresh_token=rt_secret'));
		await expect(
			readHostedAccessToken(refreshWorkos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1',
				forceRefreshToken: true
			})
		).resolves.toEqual({
			kind: 'transient',
			error: TRANSIENT_HOSTED_AUTH_ERROR
		});
	});

	it('revokes a valid session and reports retryable revocation failures', async () => {
		const workos = fakeWorkOS({
			authenticate: {
				authenticated: true,
				accessToken: 'access-token',
				user,
				sessionId: 'session_1'
			}
		});
		expect(
			await revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1'
			})
		).toEqual({ ok: true });
		expect(workos.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_1' });

		workos.revokeSession.mockRejectedValue(new Error('offline'));
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1'
			})
		).resolves.toEqual({ ok: false });
		workos.authenticate.mockRejectedValue(new Error('private SDK diagnostics'));
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1'
			})
		).resolves.toEqual({ ok: false });
	});

	it('refreshes an expired access token and preserves the rotated cookie when revocation fails', async () => {
		const workos = fakeWorkOS({
			authenticate: { authenticated: false, reason: 'invalid_jwt' },
			refresh: { authenticated: true, sessionId: 'session_1', sealedSession: 'rotated-seal' }
		});
		workos.revokeSession.mockRejectedValueOnce(new Error('offline'));
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'expired-access-token-seal'
			})
		).resolves.toEqual({ ok: false, sealedSession: 'rotated-seal' });
		expect(workos.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_1' });
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'rotated-seal'
			})
		).resolves.toEqual({ ok: true });
	});

	it('does not treat a transient refresh failure as a revoked session', async () => {
		const workos = fakeWorkOS({
			authenticate: { authenticated: false, reason: 'invalid_jwt' },
			refresh: { authenticated: false, retryable: true, reason: 'network_error' }
		});
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1'
			})
		).resolves.toEqual({ ok: false });
		expect(workos.revokeSession).not.toHaveBeenCalled();
	});

	it('allows cookie cleanup when no usable session remains', async () => {
		const workos = fakeWorkOS({
			authenticate: { authenticated: false, reason: 'invalid_jwt' },
			refresh: { authenticated: false, retryable: false, reason: 'invalid_grant' }
		});
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: 'sealed-1'
			})
		).resolves.toEqual({ ok: true });
		await expect(
			revokeHostedSession(workos, {
				env: readHostedAuthEnv(env),
				sessionCookie: undefined
			})
		).resolves.toEqual({ ok: true });
		expect(workos.revokeSession).not.toHaveBeenCalled();
	});
});

function fakeWorkOS(options: {
	authorization?: { url: string; state: string; codeVerifier: string };
	authenticate?: {
		authenticated: boolean;
		accessToken?: string;
		user?: typeof user;
		sessionId?: string;
		reason?: string;
	};
	refresh?: {
		authenticated: boolean;
		sessionId?: string;
		retryable?: boolean;
		reason?: string;
		sealedSession?: string;
		session?: { accessToken?: string; user?: typeof user };
	};
}) {
	const authenticate = vi.fn(async () => options.authenticate ?? { authenticated: false });
	const refresh = vi.fn(async () => options.refresh ?? { authenticated: false, retryable: false });
	const authenticateWithCode = vi.fn(async () => ({
		sealedSession: 'sealed-session',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		user
	}));
	const getAuthorizationUrlWithPKCE = vi.fn(
		async () =>
			options.authorization ?? {
				url: 'https://api.workos.com/user_management/authorize',
				state: 'state-1',
				codeVerifier: 'verifier-1'
			}
	);
	const revokeSession = vi.fn(async () => undefined);
	const workos = {
		authenticate,
		authenticateWithCode,
		refresh,
		revokeSession,
		userManagement: {
			getAuthorizationUrlWithPKCE,
			authenticateWithCode,
			loadSealedSession: vi.fn(() => ({ authenticate, refresh })),
			revokeSession
		}
	};
	// SAFETY: this double implements only the SDK methods exercised by hosted auth.
	return workos as typeof workos & HostedWorkOS;
}
