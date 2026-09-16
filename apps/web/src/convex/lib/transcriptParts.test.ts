import { describe, expect, it } from 'vitest';
import { toolInvocationIdForJob } from '@convex/lib/transcriptParts';
import type { Id } from '@convex/_generated/dataModel';

describe('tool progress source keys', () => {
	it('prefers a stored invocation id and falls back to the job document id', () => {
		// SAFETY: Tests use stable opaque strings where only ID equality matters.
		const jobId = 'job-1' as Id<'executorJobs'>;
		expect(toolInvocationIdForJob({ _id: jobId, toolInvocationId: 'inv-1' })).toBe('inv-1');
		expect(toolInvocationIdForJob({ _id: jobId })).toBe(jobId);
	});
});
