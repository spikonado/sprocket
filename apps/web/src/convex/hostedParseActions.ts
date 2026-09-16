'use node';

import { NonRetryableError } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { env, internalAction } from '@convex/_generated/server';
import {
	FIRECRAWL_PARSE_OPTIONS,
	FIRECRAWL_PARSE_TIMEOUT_MS,
	FIRECRAWL_PARSE_URL,
	HOSTED_PARSE_MAX_INPUT_BYTES,
	HOSTED_PARSE_MAX_OUTPUT_BYTES,
	parseFirecrawlParseResponse,
	readBoundedResponseBytes,
	shortHostedParseError
} from '@convex/lib/hostedParse';

const executeArgs = {
	requestId: v.id('hostedParseRequests'),
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
};

const executeReturns = v.object({
	skipped: v.optional(v.boolean()),
	resultStorageId: v.optional(v.id('_storage'))
});

function configuredFirecrawlApiKey(): string | undefined {
	return env.FIRECRAWL_API_KEY?.trim() || undefined;
}

export const executeHostedParse = internalAction({
	args: executeArgs,
	returns: executeReturns,
	handler: async (ctx, args) => {
		const work = await ctx.runQuery(internal.hostedParse.getParseWork, args);
		if (!work) {
			return { skipped: true };
		}
		const apiKey = configuredFirecrawlApiKey();
		if (!apiKey) {
			throw new NonRetryableError('Hosted document parsing is not configured.');
		}
		const inputUrl = await ctx.storage.getUrl(work.inputStorageId);
		if (!inputUrl) {
			throw new NonRetryableError('Uploaded file is unavailable.');
		}
		let inputBytes: Uint8Array;
		try {
			inputBytes = await fetchStorageBytes(inputUrl);
		} catch (error) {
			throw new NonRetryableError(
				error instanceof Error ? error.message : 'Failed to read the uploaded file.'
			);
		}
		let providerResponse: Response;
		try {
			providerResponse = await fetch(FIRECRAWL_PARSE_URL, {
				method: 'POST',
				redirect: 'error',
				headers: { Authorization: `Bearer ${apiKey}` },
				body: firecrawlParseForm(inputBytes, work.filename),
				signal: AbortSignal.timeout(FIRECRAWL_PARSE_TIMEOUT_MS)
			});
		} catch (error) {
			throw new NonRetryableError(
				error instanceof Error ? shortHostedParseError(error.message) : 'Firecrawl parse failed.'
			);
		}
		let responseBytes: Uint8Array;
		try {
			responseBytes = await readBoundedResponseBytes(
				providerResponse,
				HOSTED_PARSE_MAX_OUTPUT_BYTES
			);
		} catch (error) {
			throw new NonRetryableError(
				error instanceof Error ? error.message : 'Firecrawl parse response is too large.'
			);
		}
		if (!providerResponse.ok) {
			throw new NonRetryableError(httpProviderError(providerResponse.status, responseBytes));
		}
		const parsed = parseFirecrawlParseResponse(
			new TextDecoder().decode(responseBytes),
			responseBytes.byteLength
		);
		if ('error' in parsed) {
			throw new NonRetryableError(parsed.error);
		}
		const resultStorageId = await ctx.storage.store(
			new Blob([parsed.markdown], { type: 'text/markdown; charset=utf-8' })
		);
		return { resultStorageId };
	}
});

function firecrawlParseForm(bytes: Uint8Array, filename: string): FormData {
	const form = new FormData();
	const copy = new Uint8Array(bytes);
	form.append('file', new Blob([copy], { type: mediaTypeForFilename(filename) }), filename);
	form.append(
		'options',
		new Blob([JSON.stringify(FIRECRAWL_PARSE_OPTIONS)], { type: 'application/json' })
	);
	return form;
}

function mediaTypeForFilename(filename: string): string {
	return filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
}

async function fetchStorageBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
	if (!response.ok) {
		throw new Error('Uploaded file is unavailable.');
	}
	return await readBoundedResponseBytes(response, HOSTED_PARSE_MAX_INPUT_BYTES);
}

function httpProviderError(status: number, responseBytes: Uint8Array): string {
	if (status === 402) return 'Firecrawl parse failed.';
	try {
		const payload = z
			.object({ error: z.string().trim().min(1) })
			.safeParse(JSON.parse(new TextDecoder().decode(responseBytes)));
		if (payload.success) return shortHostedParseError(payload.data.error);
	} catch {
		// Fall through to the status message.
	}
	return `Firecrawl parse failed (${status}).`;
}
