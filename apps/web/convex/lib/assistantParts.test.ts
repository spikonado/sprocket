import { describe, expect, it } from 'vitest';
import { joinAssistantTextParts } from '@convex/lib/assistantParts';

describe('assistant text parts', () => {
	it('separates text from distinct model turns', () => {
		expect(
			joinAssistantTextParts([
				{ type: 'text', id: 'text-1', text: 'First turn.', turnId: 'turn-1' },
				{ type: 'text', id: 'text-2', text: ' Continued.', turnId: 'turn-1' },
				{ type: 'text', id: 'text-3', text: 'Second turn.', turnId: 'turn-2' }
			])
		).toBe('First turn. Continued.\n\nSecond turn.');
	});
});
