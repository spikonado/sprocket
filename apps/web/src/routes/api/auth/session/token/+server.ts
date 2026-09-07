import { json } from '@sveltejs/kit';
import {
	HOSTED_SESSION_COOKIE,
	hostedAuthJsonHeaders,
	hostedCookieDelete,
	hostedTokenJson,
	parseHostedTokenJson,
	readHostedAccessToken,
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

	const parsed = parseHostedTokenJson(await event.request.text());
	if (!parsed.ok) {
		return json({ error: 'Invalid JSON' }, { status: 400, headers: hostedAuthJsonHeaders() });
	}

	const { authEnv, workos } = hostedAuthContext();
	const result = await readHostedAccessToken(workos, {
		env: authEnv,
		sessionCookie: event.cookies.get(HOSTED_SESSION_COOKIE),
		forceRefreshToken: parsed.forceRefreshToken
	});
	const response = hostedTokenJson(result);
	if (response.clearSession) {
		event.cookies.delete(HOSTED_SESSION_COOKIE, hostedCookieDelete);
	} else if (response.sealedSession) {
		event.cookies.set(HOSTED_SESSION_COOKIE, response.sealedSession, sessionCookieOptions());
	}
	return json(response.body, {
		status: response.status,
		headers: hostedAuthJsonHeaders()
	});
};
