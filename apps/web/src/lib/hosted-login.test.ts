import { describe, expect, it } from 'vitest';
import {
	consumeHostedLoginSearch,
	hostedLoginFailureFromCallbackParams,
	hostedLoginFailureFromExchange,
	hostedLoginFailureFromOauthError,
	hostedLoginFailureFromSearch,
	hostedLoginFailureMessage,
	hostedLoginFailurePath
} from './hosted-login';

const secretLike =
	/invalid_grant|error_description|access_denied|sk_|rt_|code_verifier|invalid_state|missing_session/;

describe('hosted login failure mapping', () => {
	it('maps WorkOS callback outcomes to allowlisted retry reasons', () => {
		expect(
			hostedLoginFailureFromCallbackParams({
				error: 'access_denied',
				code: '',
				state: ''
			})
		).toBe('cancelled');
		expect(
			hostedLoginFailureFromCallbackParams({
				error: 'invalid_request',
				code: 'code-1',
				state: 'state-1'
			})
		).toBe('failed');
		expect(
			hostedLoginFailureFromCallbackParams({
				error: null,
				code: '',
				state: 'state-1'
			})
		).toBe('failed');
		expect(
			hostedLoginFailureFromCallbackParams({
				error: null,
				code: 'code-1',
				state: ''
			})
		).toBe('failed');
		expect(
			hostedLoginFailureFromCallbackParams({
				error: null,
				code: 'code-1',
				state: 'state-1'
			})
		).toBeNull();
		expect(hostedLoginFailureFromOauthError('server_error')).toBe('failed');
		expect(hostedLoginFailureFromExchange('invalid_state')).toBe('expired');
		expect(hostedLoginFailureFromExchange('missing_session')).toBe('failed');
	});

	it('never puts WorkOS codes or descriptions in the retry URL or message', () => {
		for (const reason of ['cancelled', 'expired', 'failed'] as const) {
			expect(hostedLoginFailurePath(reason)).toBe(`/?login=${reason}`);
			expect(hostedLoginFailureMessage(reason)).not.toMatch(secretLike);
		}
		expect(hostedLoginFailureFromSearch('?login=failed&error_description=invalid_grant')).toBe(
			'failed'
		);
		expect(hostedLoginFailureFromSearch('?login=access_denied')).toBeNull();
		expect(hostedLoginFailureFromSearch('?login=invalid_state')).toBeNull();
		expect(
			hostedLoginFailureMessage(hostedLoginFailureFromOauthError('invalid_grant'))
		).not.toMatch(secretLike);
	});

	it('strips OAuth leftovers from the login query and keeps unrelated params', () => {
		expect(consumeHostedLoginSearch('?workspace=abc')).toBeNull();
		expect(consumeHostedLoginSearch('?login=failed&error_description=invalid_grant')).toEqual({
			reason: 'failed',
			search: ''
		});
		expect(consumeHostedLoginSearch('?login=cancelled&error=access_denied')).toEqual({
			reason: 'cancelled',
			search: ''
		});
		expect(
			consumeHostedLoginSearch('?login=failed&workspace=abc&error_description=secret')
		).toEqual({
			reason: 'failed',
			search: '?workspace=abc'
		});
		expect(consumeHostedLoginSearch('?login=invalid_grant')).toEqual({
			reason: null,
			search: ''
		});
	});
});
