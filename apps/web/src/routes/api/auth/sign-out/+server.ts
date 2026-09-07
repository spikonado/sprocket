import { json } from '@sveltejs/kit';
import {
	HOSTED_LOGIN_COOKIE,
	HOSTED_SESSION_COOKIE,
	HOSTED_SIGN_OUT_ERROR,
	hostedAuthJsonHeaders,
	hostedCookieDelete,
	revokeHostedSession,
	sessionCookieOptions
} from '$lib/server/hosted-auth';
import {
	hostedAuthContext,
	hostedOriginForbidden,
	requireHostedWeb
} from '$lib/server/hosted-request';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	requireHostedWeb();
	const forbidden = hostedOriginForbidden(event);
	if (forbidden) {
		return forbidden;
	}

	const { authEnv, workos } = hostedAuthContext();
	const result = await revokeHostedSession(workos, {
		env: authEnv,
		sessionCookie: event.cookies.get(HOSTED_SESSION_COOKIE)
	});
	if (!result.ok) {
		if (result.sealedSession) {
			event.cookies.set(HOSTED_SESSION_COOKIE, result.sealedSession, sessionCookieOptions());
		}
		return json(
			{ error: HOSTED_SIGN_OUT_ERROR },
			{ status: 503, headers: hostedAuthJsonHeaders() }
		);
	}
	event.cookies.delete(HOSTED_SESSION_COOKIE, hostedCookieDelete);
	event.cookies.delete(HOSTED_LOGIN_COOKIE, hostedCookieDelete);
	return json({ ok: true }, { headers: hostedAuthJsonHeaders() });
};
