import { expect, test } from 'bun:test';
import { dropExceptionsOutsideApp } from './index';

test('keeps exceptions thrown by page scripts and drops ones without their frames', () => {
	const fromPage = {
		event: '$exception',
		properties: {
			$exception_list: [{ stacktrace: { frames: [{ in_app: false }, { in_app: true }] } }]
		}
	};

	const scriptError = { event: '$exception', properties: { $exception_list: [{}] } };

	expect(dropExceptionsOutsideApp(fromPage)).toBe(fromPage);
	expect(dropExceptionsOutsideApp(scriptError)).toBeNull();
});
