import { describe, expect, it } from 'vitest';
import { initConvexTest, readTranscriptRange, seedOwnedThread } from '../test.setup';
import { redactCompletion, redactSecrets } from './secretRedaction';
import { appendTranscriptPart } from './transcriptParts';

describe('redactSecrets', () => {
	it.each([
		['OPENAI_API_KEY=sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5', 'OPENAI_API_KEY=[redacted:openai-key]'],
		['token ghp_YQKG3NZUybE8CJqHhfmRxpysOBgPfmNd9wzM', 'token [redacted:github-token]'],
		['aws AKIAIOSFODNN7EXAMPLE', 'aws [redacted:aws-access-key]'],
		['-SLACK=x\n-xoxb-123456789012-ab12cd34ef56', '-SLACK=x\n-[redacted:slack-token]'],
		['postgres://app:s3cr3tPass@db:5432/app', 'postgres://app:[redacted:password]@db:5432/app'],
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
			'"sha512-1Duyg48TdJNdyhEB8Xn1L36bT9Pv6GUtlKjHxOys8xkaF/rQq3XJE+bAurSK/AgIz5mGFsb77cn9Pb20+WCScw=="',
			'narHash = "sha256-Zx7Qp2Lm9Vb4Nc8Rt1Ws6Yh3Kd5Jf0Aa/Q3v9xYb2LmN8pR4tW6zA1cD5="',
			'useTranscriptRowsVirtualizer2 attachmentDownloadByStorageId',
			'password: process.env.DB_PASSWORD',
			'let token = uuid::Uuid::new_v4();',
			'max_tokens: Option<u64>,'
		].join('\n');

		expect(redactSecrets(text)).toBe(text);
	});

	it.each(['eyJ-', '--eyJ', 'sk-ant-', 'xoxb-', 'a+'])('stays linear on repeated %s', (unit) => {
		const started = performance.now();

		redactSecrets(unit.repeat(250_000));
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

it('redacts reply text and keeps reasoning as the provider returned it', () => {
	const text = 'use sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5';

	const reasoning = {
		type: 'reasoning' as const,
		id: 'r',
		text,
		providerMetadata: { rigNative: { type: 'thinking', signature: 'sig' } }
	};

	const { items } = redactCompletion({ items: [reasoning, { type: 'text', id: 't', text }] });

	expect(items).toEqual([reasoning, { type: 'text', id: 't', text: 'use [redacted:openai-key]' }]);
});

it('stores transcript parts with secrets redacted and accepts retries of raw stored parts', async () => {
	const t = initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);
	const rawOutput = { stdout: 'OPENAI_API_KEY=sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5' };

	await t.run(async (ctx) => {
		const run = await ctx.db
			.query('runs')
			.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
			.first();

		const args = {
			threadId,
			sourceKey: 'tool:secret:finished',
			kind: 'tool' as const,
			runId: run!._id,
			tool: {
				toolInvocationId: 'secret',
				name: 'exec_command',
				output: rawOutput,
				status: 'completed' as const
			},
			work: { ranges: [], sectionKey: 'test-tool:secret' }
		};

		const { part } = await appendTranscriptPart(ctx, args);

		const legacy = await ctx.db.insert('threadTranscriptParts', {
			...args,
			sourceKey: 'tool:legacy:finished',
			number: part.number + 1
		});

		const retry = await appendTranscriptPart(ctx, { ...args, sourceKey: 'tool:legacy:finished' });

		expect(retry).toMatchObject({ inserted: false, part: { _id: legacy } });
	});

	const { parts } = await readTranscriptRange(asUser, threadId, 0, 1);
	expect(parts[0]?.tool?.output).toEqual({ stdout: 'OPENAI_API_KEY=[redacted:openai-key]' });
});
