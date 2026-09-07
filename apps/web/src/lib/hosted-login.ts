export const HOSTED_LOGIN_QUERY = 'login';

const HOSTED_LOGIN_OAUTH_PARAMS = [
	'login',
	'error',
	'error_description',
	'error_uri',
	'code',
	'state'
] as const;

export type HostedLoginFailure = 'cancelled' | 'expired' | 'failed';

export function hostedLoginFailureFromOauthError(error: string): HostedLoginFailure {
	return error === 'access_denied' ? 'cancelled' : 'failed';
}

export function hostedLoginFailureFromCallbackParams(params: {
	error: string | null;
	code: string;
	state: string;
}): HostedLoginFailure | null {
	if (params.error) {
		return hostedLoginFailureFromOauthError(params.error);
	}
	if (!params.code || !params.state) {
		return 'failed';
	}
	return null;
}

export function hostedLoginFailureFromExchange(
	error: 'invalid_state' | 'missing_session'
): HostedLoginFailure {
	return error === 'invalid_state' ? 'expired' : 'failed';
}

export function hostedLoginFailureFromSearch(search: string): HostedLoginFailure | null {
	const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
	const value = params.get(HOSTED_LOGIN_QUERY);
	if (value === 'cancelled' || value === 'expired' || value === 'failed') {
		return value;
	}
	return null;
}

export function consumeHostedLoginSearch(search: string): {
	reason: HostedLoginFailure | null;
	search: string;
} | null {
	const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
	if (!params.has(HOSTED_LOGIN_QUERY)) {
		return null;
	}
	const reason = hostedLoginFailureFromSearch(search);
	for (const key of HOSTED_LOGIN_OAUTH_PARAMS) {
		params.delete(key);
	}
	const next = params.toString();
	return { reason, search: next ? `?${next}` : '' };
}

export function hostedLoginFailureMessage(reason: HostedLoginFailure): string {
	switch (reason) {
		case 'cancelled':
			return 'Sign-in was cancelled. Try again when you are ready.';
		case 'expired':
			return 'Sign-in expired. Try again.';
		case 'failed':
			return 'Sign-in did not complete. Try again.';
	}
}

export function hostedLoginFailurePath(reason: HostedLoginFailure): string {
	return `/?${HOSTED_LOGIN_QUERY}=${reason}`;
}
