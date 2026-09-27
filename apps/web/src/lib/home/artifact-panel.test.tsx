import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from '$convex/_generated/api';
import {
	ArtifactPanel,
	createConvexArtifactClient,
	useArtifactPanel,
	type ConvexArtifactClient
} from '$lib/home/artifact-panel';

function createFakeClient(readRevision: () => number | undefined) {
	const listeners = new Set<() => void>();
	const disposed = vi.fn<() => void>();
	const watch: ReturnType<ConvexArtifactClient['watchQuery']> = {
		onUpdate: (callback) => {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
				disposed();
			};
		},
		localQueryResult: readRevision
	};
	const watchQuery = vi.fn<ConvexArtifactClient['watchQuery']>(() => watch);
	const client: ConvexArtifactClient = {
		query: async () => ({ page: [], isDone: true, continueCursor: '', revision: 0 }),
		watchQuery
	};
	return {
		client,
		disposed,
		watchQuery,
		notify: () => {
			for (const listener of listeners) listener();
		}
	};
}

const scope = (repositoryKey: string) => ({
	userId: 'user-a',
	repositoryKey,
	workspacePath: `/worktrees/${repositoryKey}`,
	threadId: null
});

it('delivers the current registry revision immediately and on every change', () => {
	let revision = 7;
	const fake = createFakeClient(() => revision);
	const onUpdate = vi.fn<(revision: number) => void>();
	const onError = vi.fn<(error: Error) => void>();

	const unsubscribe = createConvexArtifactClient(fake.client).onUpdate(
		api.artifacts.getArtifactState,
		{ repositoryKey: 'github.com/acme/robot' },
		onUpdate,
		onError
	);

	expect(fake.watchQuery).toHaveBeenCalledWith(api.artifacts.getArtifactState, {
		repositoryKey: 'github.com/acme/robot'
	});
	expect(onUpdate).toHaveBeenCalledWith(7);

	revision = 8;
	fake.notify();
	expect(onUpdate).toHaveBeenLastCalledWith(8);
	expect(onError).not.toHaveBeenCalled();

	unsubscribe();
	expect(fake.disposed).toHaveBeenCalledTimes(1);
});

it('surfaces registry failures without throwing at the caller', () => {
	const fake = createFakeClient(() => {
		throw new Error('Artifact registry unavailable.');
	});
	const onUpdate = vi.fn<(revision: number) => void>();
	const onError = vi.fn<(error: Error) => void>();

	createConvexArtifactClient(fake.client).onUpdate(
		api.artifacts.getArtifactState,
		{ repositoryKey: 'github.com/acme/robot' },
		onUpdate,
		onError
	);
	fake.notify();

	expect(onUpdate).not.toHaveBeenCalled();
	expect(onError).toHaveBeenCalledWith(new Error('Artifact registry unavailable.'));
});

it('notifies subscribers on panel changes and keeps one instance per mount', () => {
	const { result, rerender } = renderHook(() => useArtifactPanel());
	const instance = result.current;
	const listener = vi.fn<() => void>();
	const unsubscribe = instance.subscribe(listener);
	const before = instance.getSnapshot();

	rerender();
	expect(result.current).toBe(instance);

	act(() => {
		instance.update({ open: true, tab: 'artifacts' });
	});
	expect(listener).toHaveBeenCalledTimes(1);
	expect(result.current.panel).toMatchObject({ open: true, tab: 'artifacts' });
	expect(instance.getSnapshot()).not.toBe(before);

	unsubscribe();
});

it('keeps a side panel snapshot per scope and restores it on return', () => {
	const panel = new ArtifactPanel();
	const listener = vi.fn<() => void>();
	panel.subscribe(listener);

	panel.selectScope(scope('robot'));
	panel.update({ open: true, expanded: true, selectedKey: 'artifact-1' });

	panel.selectScope(scope('other'));
	expect(panel.panel.open).toBe(false);
	expect(panel.fullscreenKey).toBeNull();

	panel.selectScope(scope('robot'));
	expect(panel.panel).toMatchObject({ open: true, expanded: true, selectedKey: 'artifact-1' });
	expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);

	panel.reset();
	expect(panel.panel.open).toBe(false);
	panel.selectScope(scope('robot'));
	expect(panel.panel.open).toBe(false);
});

it('clears the fullscreen artifact when switching scope or resetting', () => {
	const panel = new ArtifactPanel();
	panel.selectScope(scope('robot'));
	panel.setFullscreenKey('artifact-1');
	expect(panel.fullscreenKey).toBe('artifact-1');

	panel.selectScope(scope('other'));
	expect(panel.fullscreenKey).toBeNull();

	panel.setFullscreenKey('artifact-2');
	panel.reset();
	expect(panel.fullscreenKey).toBeNull();
});
