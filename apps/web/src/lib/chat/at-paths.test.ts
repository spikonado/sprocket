import { describe, expect, it } from 'vitest';
import { applyPathSelection, getActiveAtMention } from './at-paths';

describe('workspace path mentions', () => {
	it('searches the mention at the caret with path case intact', () => {
		expect(getActiveAtMention('Compare @src/App.tsx with this', 16)).toEqual({
			query: 'src/App',
			start: 8,
			quoted: false
		});
		expect(getActiveAtMention('Inspect @', 9)?.query).toBe('');
		expect(getActiveAtMention('Inspect @"my project/so', 23)?.query).toBe('my project/so');
		expect(getActiveAtMention('Write to dev@example.com', 24)).toBeNull();
		expect(getActiveAtMention('Inspect @src/app.tsx ', 21)).toBeNull();
	});

	it('replaces the full token when selecting from its middle', () => {
		expect(
			applyPathSelection('Compare @src/old.ts with @tests', 12, {
				path: 'src/app.tsx',
				kind: 'file'
			})
		).toEqual({ text: 'Compare @src/app.tsx with @tests', caret: 21 });
	});

	it('quotes paths with spaces and marks directories with a trailing slash', () => {
		const selection = applyPathSelection('Inspect @my', 11, {
			path: 'my project',
			kind: 'directory'
		});

		expect(selection).toEqual({ text: 'Inspect @"my project/" ', caret: 23 });
		expect(getActiveAtMention(selection?.text ?? '', selection?.caret ?? 0)).toBeNull();
		expect(
			applyPathSelection('Inspect @"my old" carefully', 12, {
				path: 'my "new" file.ts',
				kind: 'file'
			})?.text
		).toBe('Inspect @"my \\"new\\" file.ts" carefully');
	});
});
