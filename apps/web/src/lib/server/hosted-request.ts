import { error, json, redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isHostedWeb } from '$lib/runtime-mode';
import {
	HOSTED_LOGIN_COOKIE,
	createHostedWorkOS,
	hostedAuthJsonHeaders,
	hostedSameOrigin,
	issueHostedAuthorization,
	loginCookieOptions,
	readHostedAuthEnv
} from './hosted-auth';

export function requireHostedWeb(): void {
	if (!isHostedWeb) {
		error(404, 'Not found');
	}
}

export function hostedAuthContext() {
	const authEnv = readHostedAuthEnv(env);
	return { authEnv, workos: createHostedWorkOS(authEnv) };
}

export function hostedOriginForbidden(
	event: Pick<RequestEvent, 'request' | 'url'>
): Response | null {
	if (hostedSameOrigin(event.request.headers.get('origin'), event.url.origin)) {
		return null;
	}
	return json({ error: 'Invalid origin' }, { status: 403, headers: hostedAuthJsonHeaders() });
}

export async function redirectToHostedAuthorization(
	event: { cookies: Cookies; url: URL },
	screenHint: 'sign-in' | 'sign-up'
): Promise<never> {
	requireHostedWeb();
	const { authEnv, workos } = hostedAuthContext();
	const { url: authorizationUrl, loginCookie } = await issueHostedAuthorization(workos, {
		env: authEnv,
		origin: event.url.origin,
		screenHint
	});
	event.cookies.set(HOSTED_LOGIN_COOKIE, loginCookie, loginCookieOptions());
	redirect(302, authorizationUrl);
}
