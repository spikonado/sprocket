import { json } from '@sveltejs/kit';
import {
	HOSTED_LOGIN_COOKIE,
	HOSTED_SESSION_COOKIE,
	hostedAuthJsonHeaders,
	hostedCookieDelete,
	revokeHostedSession
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
	await revokeHostedSession(workos, {
		env: authEnv,
		sessionCookie: event.cookies.get(HOSTED_SESSION_COOKIE)
	});
	event.cookies.delete(HOSTED_SESSION_COOKIE, hostedCookieDelete);
	event.cookies.delete(HOSTED_LOGIN_COOKIE, hostedCookieDelete);
	return json({ ok: true }, { headers: hostedAuthJsonHeaders() });
};
