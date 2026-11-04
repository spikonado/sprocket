import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { convexClientErrorMessage } from './convex-error';

describe('convexClientErrorMessage', () => {
	it('reads string and coded ConvexError payloads', () => {
		expect(convexClientErrorMessage(new ConvexError('Plain failure.'))).toBe('Plain failure.');
		expect(
			convexClientErrorMessage(
				new ConvexError({ code: 'RUN_CANCELLED', message: 'Run is cancelled.' })
			)
		).toBe('Run is cancelled.');
	});
});
