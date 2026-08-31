import { describe, expect, it } from 'vitest';
import { isUnparseablePageFailure, scrapeHttpErrorMessage } from '@convex/webTools';

describe('scrape HTTP failures', () => {
	it('turns a Context.dev HTTP error into a readable message', () => {
		const error = new Error(
			'Uncaught ConvexError: Uncaught ConvexError: {"message":"Target page returned a 404","status":404,"response":{"error_code":"NOT_FOUND"}}\n    at contextRequest (http.js:24:12)'
		);
		expect(scrapeHttpErrorMessage(error)).toBe('This webpage returned a 404 error.');
	});

	it('ignores non-HTTP and malformed errors', () => {
		expect(scrapeHttpErrorMessage(new Error('{"status":200}'))).toBeUndefined();
		expect(scrapeHttpErrorMessage(new Error('Context.dev scrape failed.'))).toBeUndefined();
	});
});

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
