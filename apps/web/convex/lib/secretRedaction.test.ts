import { describe, expect, it } from 'vitest';
import { initConvexTest, readTranscriptRange, seedOwnedThread } from '../test.setup';
import { redactSecrets } from './secretRedaction';
import { appendTranscriptPart } from './transcriptParts';

describe('redactSecrets', () => {
	it.each([
		['OPENAI_API_KEY=sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5', 'OPENAI_API_KEY=[redacted:openai-key]'],
		['token ghp_YQKG3NZUybE8CJqHhfmRxpysOBgPfmNd9wzM', 'token [redacted:github-token]'],
		['aws AKIAIOSFODNN7EXAMPLE', 'aws [redacted:aws-access-key]'],
		['postgres://app:s3cr3tPass@db:5432/app', 'postgres://app:[redacted:password]@db:5432/app'],
		['"client_secret": "9f86d081884c7d65"', '"client_secret": "[redacted:secret]"'],
		['Authorization: Bearer abc123def456ghi', 'Authorization: Bearer [redacted:secret]'],
		['key Zx7Qp2Lm9Vb4Nc8Rt1Ws6Yh3Kd5Jf0', 'key [redacted:high-entropy]'],
		[
			'-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
			'[redacted:private-key]'
		]
	])('redacts %s', (input, expected) => {
		expect(redactSecrets(input)).toBe(expected);
	});

	it('keeps IDs, hashes and code that look random but are not secrets', () => {
		const text = [
			'commit f59964f3a1b2c3d4e5f60718293a4b5c6d7e8f90',
			'thread js724ftx3y7e6d5e1n73egy7t58jw025',
			'user user_01KXVEGKXJPVMPPVEAWY4T7DWB',
			'uuid 25e57611-c2cb-4934-8142-fde1a3644a46',
			'integrity sha512-Zx7Qp2Lm9Vb4Nc8Rt1Ws6Yh3Kd5Jf0Aa',
			'useTranscriptRowsVirtualizer2 attachmentDownloadByStorageId',
			'password: process.env.DB_PASSWORD'
		].join('\n');

		expect(redactSecrets(text)).toBe(text);
	});
});

it('stores transcript parts with secrets redacted', async () => {
	const t = initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);

	await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
			.first();

		await appendTranscriptPart(ctx, {
			threadId,
			sourceKey: 'tool:secret:finished',
			kind: 'tool',
			runId: run!._id,
			tool: {
				toolInvocationId: 'secret',
				name: 'exec_command',
				output: { stdout: 'OPENAI_API_KEY=sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5' },
				status: 'completed'
			},
			work: { ranges: [], sectionKey: 'test-tool:secret' }
		});
	});

	const { parts } = await readTranscriptRange(asUser, threadId, 0, 1);
	expect(parts[0]?.tool?.output).toEqual({ stdout: 'OPENAI_API_KEY=[redacted:openai-key]' });
});
