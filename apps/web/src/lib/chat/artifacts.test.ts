import { describe, expect, it } from 'vitest';
import { nextArtifactRevisionWatch, type ArtifactRevision } from './artifacts';

function revision(id: string, currentVersion: number, updatedAt: number): ArtifactRevision {
	return { id, currentVersion, updatedAt };
}

describe('nextArtifactRevisionWatch', () => {
	it('seeds without reporting a change on first observation', () => {
		const current = [revision('a', 1, 10), revision('b', 2, 20)];
		const { revisions, changedId } = nextArtifactRevisionWatch(null, current);

		expect(changedId).toBeNull();
		expect([...revisions.keys()]).toEqual(['a', 'b']);
	});

	it('reports a newly created artifact', () => {
		const previous = new Map([['a', revision('a', 1, 10)]]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 1, 10),
			revision('b', 1, 30)
		]);

		expect(changedId).toBe('b');
	});

	it('reports an updated artifact version', () => {
		const previous = new Map([
			['a', revision('a', 1, 10)],
			['b', revision('b', 1, 20)]
		]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 1, 10),
			revision('b', 2, 40)
		]);

		expect(changedId).toBe('b');
	});

	it('picks the most recently updated artifact when several change', () => {
		const previous = new Map([
			['a', revision('a', 1, 10)],
			['b', revision('b', 1, 20)]
		]);
		const { changedId } = nextArtifactRevisionWatch(previous, [
			revision('a', 2, 50),
			revision('b', 2, 45)
		]);

		expect(changedId).toBe('a');
	});

	it('reports null when nothing changed', () => {
		const previous = new Map([['a', revision('a', 1, 10)]]);
		const { changedId } = nextArtifactRevisionWatch(previous, [revision('a', 1, 10)]);

		expect(changedId).toBeNull();
	});

	it('ignores removals and updatedAt-only noise', () => {
		const previous = new Map([
			['a', revision('a', 1, 10)],
			['b', revision('b', 1, 20)]
		]);
		const { changedId, revisions } = nextArtifactRevisionWatch(previous, [revision('a', 1, 99)]);

		expect(changedId).toBeNull();
		expect([...revisions.keys()]).toEqual(['a']);
	});
});
