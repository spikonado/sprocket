import { redirect } from '@sveltejs/kit';
import {
	hostedLoginFailureFromCallbackParams,
	hostedLoginFailurePath,
	type HostedLoginFailure
} from '$lib/hosted-login';
import {
	HOSTED_LOGIN_COOKIE,
	HOSTED_SESSION_COOKIE,
	exchangeHostedAuthorizationCode,
	hostedCookieDelete,
	sessionCookieOptions
} from '$lib/server/hosted-auth';
import { hostedAuthContext, requireHostedWeb } from '$lib/server/hosted-request';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url }) => {
	requireHostedWeb();
	const fail = (reason: HostedLoginFailure): never => {
		cookies.delete(HOSTED_LOGIN_COOKIE, hostedCookieDelete);
		redirect(303, hostedLoginFailurePath(reason));
	};

	const code = url.searchParams.get('code')?.trim() ?? '';
	const state = url.searchParams.get('state')?.trim() ?? '';
	const callbackFailure = hostedLoginFailureFromCallbackParams({
		error: url.searchParams.get('error'),
		code,
		state
	});
	if (callbackFailure) {
		fail(callbackFailure);
	}

	const { authEnv, workos } = hostedAuthContext();
	const exchanged = await exchangeHostedAuthorizationCode(workos, {
		env: authEnv,
		code,
		state,
		loginCookie: cookies.get(HOSTED_LOGIN_COOKIE)
	});
	cookies.delete(HOSTED_LOGIN_COOKIE, hostedCookieDelete);
	if ('error' in exchanged) {
		return fail(exchanged.error);
	}

	cookies.set(HOSTED_SESSION_COOKIE, exchanged.sealedSession, sessionCookieOptions());
	redirect(303, '/');
};
