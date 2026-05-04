import { describe, expect, it } from 'vitest';

import { shouldSubmitComposerFromKeydown } from '$lib/composer';

describe('shouldSubmitComposerFromKeydown', () => {
	it('submits on enter', () => {
		expect(
			shouldSubmitComposerFromKeydown({
				isComposing: false,
				key: 'Enter',
				shiftKey: false
			})
		).toBe(true);
	});

	it('keeps shift+enter as a newline', () => {
		expect(
			shouldSubmitComposerFromKeydown({
				isComposing: false,
				key: 'Enter',
				shiftKey: true
			})
		).toBe(false);
	});

	it('does not submit while the ime is composing', () => {
		expect(
			shouldSubmitComposerFromKeydown({
				isComposing: true,
				key: 'Enter',
				shiftKey: false
			})
		).toBe(false);
	});

	it('ignores other keys', () => {
		expect(
			shouldSubmitComposerFromKeydown({
				isComposing: false,
				key: 'Escape',
				shiftKey: false
			})
		).toBe(false);
	});
});
