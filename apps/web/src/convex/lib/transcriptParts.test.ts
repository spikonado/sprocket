import { describe, expect, it } from 'vitest';
import {
	isTranscriptToolTerminalStatus,
	toolInvocationIdForJob,
	toolSourceKey
} from '@convex/lib/transcriptParts';
import type { Id } from '@convex/_generated/dataModel';

describe('tool progress source keys', () => {
	it('builds deterministic started and finished keys from the invocation id', () => {
		expect(toolSourceKey('inv-1', 'started')).toBe('tool:inv-1:started');
		expect(toolSourceKey('inv-1', 'finished')).toBe('tool:inv-1:finished');
	});

	it('prefers a stored invocation id and falls back to the job document id', () => {
		// SAFETY: Tests use stable opaque strings where only ID equality matters.
		const jobId = 'job-1' as Id<'executorJobs'>;
		expect(toolInvocationIdForJob({ _id: jobId, toolInvocationId: 'inv-1' })).toBe('inv-1');
		expect(toolInvocationIdForJob({ _id: jobId })).toBe(jobId);
	});

	it('treats completed, failed, and cancelled as terminal', () => {
		expect(isTranscriptToolTerminalStatus('started')).toBe(false);
		expect(isTranscriptToolTerminalStatus('completed')).toBe(true);
		expect(isTranscriptToolTerminalStatus('failed')).toBe(true);
		expect(isTranscriptToolTerminalStatus('cancelled')).toBe(true);
	});
});
