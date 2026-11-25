import { describe, expect, it } from 'vitest';
import { initConvexTest, readTranscriptRange, seedOwnedThread } from '../test.setup';
import { redactCompletion, redactSecrets, redactTool } from './secretRedaction';
import { appendTranscriptPart } from './transcriptParts';

describe('redactSecrets', () => {
	it.each([
		['OPENAI_API_KEY=sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5', 'OPENAI_API_KEY=[redacted:openai-key]'],
		['token ghp_YQKG3NZUybE8CJqHhfmRxpysOBgPfmNd9wzM', 'token [redacted:github-token]'],
		['aws AKIAIOSFODNN7EXAMPLE', 'aws [redacted:aws-access-key]'],
		['-SLACK=x\n-xoxb-123456789012-ab12cd34ef56', '-SLACK=x\n-[redacted:slack-token]'],
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

	it.each(['eyJ-', '--eyJ', 'sk-ant-', 'xoxb-', 'a+'])('stays linear on repeated %s', (unit) => {
		const started = performance.now();

		redactSecrets(unit.repeat(250_000));
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

it('redacts secrets held under secret-like field names', () => {
	const tool = redactTool({
		toolInvocationId: 'call',
		name: 'exec_command',
		input: { env: { password: 'abc123def456ghi', mode: 'abc123def456ghi' } },
		status: 'completed'
	});

	expect(tool.input).toEqual({ env: { password: '[redacted:secret]', mode: 'abc123def456ghi' } });
});

it('drops the signature of Claude thinking that redaction changes', () => {
	const signed = { rigNative: { type: 'thinking', signature: 'sig' } };

	const thinking = (text: string) => ({
		type: 'reasoning' as const,
		id: 'r',
		text,
		providerMetadata: signed
	});

	const { items } = redactCompletion({
		items: [thinking('use sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5'), thinking('plan')]
	});

	expect(items).toEqual([
		{ type: 'reasoning', id: 'r', text: 'use [redacted:openai-key]' },
		thinking('plan')
	]);
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
