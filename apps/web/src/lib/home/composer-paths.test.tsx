import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerPaths, type ComposerPathSource } from './composer-paths';
import type { WorkspaceSearchResult } from '$lib/types/sprocket';

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

async function advance(milliseconds = 100) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(milliseconds);
	});
}

describe('composer workspace search', () => {
	it('debounces typing and ignores a superseded response', async () => {
		let resolveOld!: (result: WorkspaceSearchResult) => void;

		const oldResult = new Promise<WorkspaceSearchResult>((resolve) => {
			resolveOld = resolve;
		});

		const search = vi.fn<ComposerPathSource['search']>((query) =>
			query === 'src' ? oldResult : Promise.resolve({ entries: [], scanning: false })
		);

		const source = { workspacePath: '/workspace', search };

		const hook = renderHook((query: string | null) => useComposerPaths(source, query), {
			initialProps: '@'
		});

		hook.rerender('src');
		await advance();
		expect(search).toHaveBeenCalledTimes(1);
		hook.rerender('tests');
		expect(search.mock.calls[0][1].aborted).toBe(true);
		await advance();
		await act(async () => {
			resolveOld({ entries: [{ path: 'src/app.ts', kind: 'file' }], scanning: false });
		});
		expect(hook.result.current.loadState).toBe('ready');
		expect(hook.result.current.entries).toEqual([]);
	});

	it('polls an unfinished scan and stops when the menu closes', async () => {
		const search = vi.fn(async () => ({ entries: [], scanning: true }));
		const source = { workspacePath: '/workspace', search };

		const hook = renderHook<ReturnType<typeof useComposerPaths>, string | null>(
			(query) => useComposerPaths(source, query),
			{
				initialProps: ''
			}
		);

		await advance();
		await advance(250);
		expect(search).toHaveBeenCalledTimes(2);
		hook.rerender(null);
		await advance(1_000);
		expect(search).toHaveBeenCalledTimes(2);
	});

	it('clears results on workspace changes and retries failures', async () => {
		const first: ComposerPathSource = {
			workspacePath: '/one',
			search: vi.fn(async (): Promise<WorkspaceSearchResult> => ({
				entries: [{ path: 'one.ts', kind: 'file' }],
				scanning: false
			}))
		};

		const second: ComposerPathSource = {
			workspacePath: '/two',
			search: vi
				.fn()
				.mockRejectedValueOnce(new Error('offline'))
				.mockResolvedValue({
					entries: [{ path: 'two.ts', kind: 'file' }],
					scanning: false
				})
		};

		const hook = renderHook((source: ComposerPathSource) => useComposerPaths(source, ''), {
			initialProps: first
		});

		await advance();
		expect(hook.result.current.entries[0]?.path).toBe('one.ts');
		hook.rerender(second);
		expect(hook.result.current.entries).toEqual([]);
		await advance();
		expect(hook.result.current.loadState).toBe('error');
		act(() => hook.result.current.retry());
		await advance();
		expect(hook.result.current.entries[0]?.path).toBe('two.ts');
	});
});
