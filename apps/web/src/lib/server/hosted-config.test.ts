import { describe, expect, it } from 'vitest';
import { publicRuntimeEnv } from './hosted-config';

describe('publicRuntimeEnv', () => {
	it('keeps trimmed PUBLIC_ values and drops secrets and blanks', () => {
		expect(
			publicRuntimeEnv({
				PUBLIC_CONVEX_URL: ' https://example.convex.cloud ',
				PUBLIC_SPROCKET_HOSTED: 'true',
				PUBLIC_EMPTY: '  ',
				WORKOS_API_KEY: 'sk_live_secret',
				WORKOS_COOKIE_PASSWORD: 'super-secret-cookie-password-value'
			})
		).toEqual({
			PUBLIC_CONVEX_URL: 'https://example.convex.cloud',
			PUBLIC_SPROCKET_HOSTED: 'true'
		});
	});
});
