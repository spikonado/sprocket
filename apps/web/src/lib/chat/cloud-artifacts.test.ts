import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import { watchCloudArtifacts } from './cloud-artifacts';
import { mergeArtifactSources, type ArtifactWatchState } from './artifacts';

function clientFixture() {
	let update: (revision: number) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const unsubscribe = vi.fn();
	const query = vi.fn<Parameters<typeof watchCloudArtifacts>[0]['query']>();
	const client: Parameters<typeof watchCloudArtifacts>[0] = {
		query,
		onUpdate: (_query, _scope, onUpdate, onError) => {
			update = onUpdate;
			fail = onError;
			return unsubscribe;
		}
	};
	return {
		client,
		query,
		unsubscribe,
		update: () => update(1),
		fail: () => fail(new Error('Denied'))
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('cloud artifact subscriptions', () => {
	it('filters a cached response from the previous account during auth handoff', async () => {
		const fixture = clientFixture();
		// SAFETY: this mocked response uses the ID only as an opaque string, never in a Convex request.
		const artifactId = 'artifact' as Id<'artifacts'>;
		fixture.query.mockResolvedValue({
			page: [
				{
					_id: artifactId,
					_creationTime: 1,
					userId: 'bob',
					repositoryKey: 'repo',
					scope: 'project',
					registrationId: 'registration',
					content: 'private',
					type: 'markdown',
					title: 'Notes',
					revision: 1,
					createdAt: 1,
					updatedAt: 1
				}
			],
			isDone: true,
			continueCursor: '',
			revision: 1
		});
		const publish = vi.fn();
		const stop = watchCloudArtifacts(
			fixture.client,
			{ userId: 'alice', repositoryKey: 'repo' },
			publish
		);
		fixture.update();
		await Promise.resolve();
		expect(publish).toHaveBeenCalledWith({ artifacts: [], stale: false, error: null });
		expect(fixture.query.mock.calls[0]?.[1]).toEqual({ repositoryKey: 'repo', cursor: null });
		stop();
	});

	it('discards a load that finishes after scope teardown', async () => {
		const fixture = clientFixture();
		let resolve: (page: Awaited<ReturnType<typeof fixture.query>>) => void = () => {};
		fixture.query.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		const publish = vi.fn();
		const stop = watchCloudArtifacts(
			fixture.client,
			{ userId: 'alice', repositoryKey: 'repo' },
			publish
		);
		fixture.update();
		stop();
		resolve({ page: [], isDone: true, continueCursor: '', revision: 1 });
		await Promise.resolve();
		expect(publish).not.toHaveBeenCalled();
		expect(fixture.unsubscribe).toHaveBeenCalledOnce();
	});

	it('rejects mixed-revision pages and retries without publishing a partial list', async () => {
		vi.useFakeTimers();
		const fixture = clientFixture();
		fixture.query.mockResolvedValueOnce({
			page: [],
			isDone: false,
			continueCursor: 'next',
			revision: 1
		});
		fixture.query.mockResolvedValueOnce({
			page: [],
			isDone: true,
			continueCursor: '',
			revision: 2
		});
		fixture.query.mockResolvedValue({ page: [], isDone: true, continueCursor: '', revision: 2 });
		const publish = vi.fn();
		const stop = watchCloudArtifacts(
			fixture.client,
			{ userId: 'alice', repositoryKey: 'repo' },
			publish
		);
		fixture.update();
		await vi.advanceTimersByTimeAsync(0);
		expect(publish).toHaveBeenLastCalledWith({
			artifacts: [],
			stale: true,
			error: expect.stringContaining('changed')
		});
		await vi.advanceTimersByTimeAsync(2_000);
		expect(publish).toHaveBeenLastCalledWith({ artifacts: [], stale: false, error: null });
		fixture.fail();
		expect(publish).toHaveBeenLastCalledWith({ artifacts: [], stale: true, error: 'Denied' });
		stop();
	});

	it('uses cloud without a local server and preserves a live local edit until disconnect', () => {
		const cloud: ArtifactWatchState = {
			artifacts: [
				{
					_id: 'id',
					userId: 'alice',
					repositoryKey: 'repo',
					scope: 'project',
					content: 'cloud',
					title: 'Notes',
					type: 'markdown',
					revision: 1,
					createdAt: 1,
					updatedAt: 1
				}
			],
			stale: false,
			error: null
		};
		const local: ArtifactWatchState = {
			...cloud,
			artifacts: [{ ...cloud.artifacts[0]!, localPath: 'notes.md', content: 'unsynced' }]
		};
		expect(mergeArtifactSources(cloud, null)).toEqual(cloud);
		expect(mergeArtifactSources(cloud, local).artifacts[0]?.content).toBe('unsynced');
		expect(mergeArtifactSources(cloud, null).artifacts[0]?.content).toBe('cloud');
	});
});
