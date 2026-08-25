import { describe, expect, it } from 'vitest';
import { isUnparseablePageFailure } from '@convex/webTools';

describe('unparseable page failures', () => {
	it('recognizes component return-validation failures', () => {
		const error = new Error(
			'Uncaught ConvexError: ReturnsValidationError: Value does not match validator. Path: .values()'
		);
		expect(isUnparseablePageFailure(error)).toBe(true);
	});

	it('leaves timeouts and other failures alone', () => {
		expect(isUnparseablePageFailure(new Error('Context.dev scrape timed out after 60000ms.'))).toBe(
			false
		);
		expect(isUnparseablePageFailure(new Error('Run is no longer active.'))).toBe(false);
	});
});
