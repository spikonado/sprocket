import { describe, expect, it } from 'vitest';
import { collectArtifacts } from './artifacts';
import type { ExecutorJob } from '$lib/types/sprocket';

function job(overrides: Partial<ExecutorJob> & Pick<ExecutorJob, 'kind' | 'payload'>): ExecutorJob {
	return {
		_id: `job-${Math.random()}`,
		projectId: 'project',
		threadId: 'thread',
		runId: 'run',
		hidden: false,
		status: 'completed',
		enqueuedAt: 1,
		sequence: 1,
		...overrides
	} as ExecutorJob;
}

describe('collectArtifacts', () => {
	it('ignores non-artifact jobs', () => {
		expect(
			collectArtifacts([job({ kind: 'web_search', payload: { query: 'hi', numResults: 3 } })])
		).toEqual([]);
	});

	it('collects created artifacts in order', () => {
		const artifacts = collectArtifacts([
			job({
				kind: 'create_artifact',
				payload: { title: 'A', contentType: 'markdown', content: '# a' },
				result: { artifactId: 'art-1', version: 1 }
			}),
			job({
				kind: 'create_artifact',
				payload: { title: 'B', contentType: 'react', content: 'function App() {}' },
				result: { artifactId: 'art-2', version: 1 }
			})
		]);
		expect(artifacts.map((a) => a.key)).toEqual(['art-1', 'art-2']);
		expect(artifacts[1]).toMatchObject({ title: 'B', artifactType: 'react' });
	});

	it('merges updates into the latest content of the same artifact', () => {
		const artifacts = collectArtifacts([
			job({
				kind: 'create_artifact',
				payload: { title: 'Mock', contentType: 'react', content: 'v1' },
				result: { artifactId: 'art-1', version: 1 }
			}),
			job({
				kind: 'update_artifact',
				payload: { artifactId: 'art-1', content: 'v2' },
				result: { artifactId: 'art-1', version: 2, title: 'Mock', contentType: 'react' }
			})
		]);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]).toMatchObject({ title: 'Mock', content: 'v2', artifactType: 'react' });
	});

	it('falls back to title-based keys while a create result is pending', () => {
		const artifacts = collectArtifacts([
			job({
				kind: 'create_artifact',
				payload: { title: 'Mock', contentType: 'html', content: 'v1' }
			}),
			job({
				kind: 'create_artifact',
				payload: { title: 'Mock', contentType: 'html', content: 'v2' },
				result: { artifactId: 'art-1', version: 2 }
			})
		]);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]).toMatchObject({ key: 'art-1', content: 'v2' });
	});
});
