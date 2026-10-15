import { v } from 'convex/values';
import { z } from 'zod';
import type { Id } from '@convex/_generated/dataModel';
import type { QueryCtx, MutationCtx } from '@convex/_generated/server';
import { MAX_FILE_NAME_LENGTH } from '@convex/lib/validators';

export const HOSTED_PARSE_MAX_INPUT_BYTES = 50_000_000;

export const HOSTED_PARSE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const HOSTED_PARSE_TTL_MS = 60 * 60 * 1_000;

export const HOSTED_PARSE_ERROR_MAX_CHARS = 500;

export const FIRECRAWL_PARSE_URL = 'https://api.firecrawl.dev/v2/parse';

export const FIRECRAWL_PARSE_TIMEOUT_MS = 300_000;

export async function registeredParseStorage(
	ctx: QueryCtx | MutationCtx,
	storageId: Id<'_storage'>
) {
	const input = await ctx.db
		.query('hostedParseRequests')
		.withIndex('by_inputStorageId', (q) => q.eq('inputStorageId', storageId))
		.first();

	if (input) return input;

	return await ctx.db
		.query('hostedParseRequests')
		.withIndex('by_resultStorageId', (q) => q.eq('resultStorageId', storageId))
		.first();
}

export const vHostedParseStatus = v.union(
	v.literal('awaiting_upload'),
	v.literal('pending'),
	v.literal('completed'),
	v.literal('failed')
);

export const vHostedParseClientStatus = v.union(
	v.literal('pending'),
	v.literal('completed'),
	v.literal('failed')
);

const FIRECRAWL_PDF_PARSER = { type: 'pdf', mode: 'auto' } as const;

/** `pages` adds per-page markdown to the response at no extra cost. */
export function firecrawlParseOptions(pages: boolean) {
	return {
		formats: ['markdown'],
		parsers: [pages ? { ...FIRECRAWL_PDF_PARSER, pages: true } : FIRECRAWL_PDF_PARSER],
		timeout: FIRECRAWL_PARSE_TIMEOUT_MS
	};
}

export function shortHostedParseError(message: string): string {
	if (message.length <= HOSTED_PARSE_ERROR_MAX_CHARS) return message;

	return `${message.slice(0, HOSTED_PARSE_ERROR_MAX_CHARS - 3)}...`;
}

export function hostedParseUploadFilename(filename: string): string | null {
	const trimmed = filename.trim();
	const base = trimmed.split(/[/\\]/).pop()?.trim() ?? '';

	if (!base || base.length > MAX_FILE_NAME_LENGTH) return null;

	return base;
}

const firecrawlParsedPageSchema = z.object({
	pageNumber: z.number().int().positive(),
	markdown: z.string()
});

export type FirecrawlParsedPage = z.infer<typeof firecrawlParsedPageSchema>;

export type FirecrawlParseSuccess = { markdown: string } | { pages: FirecrawlParsedPage[] };

export type FirecrawlParseFailure = { error: string };

const firecrawlResponseSchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
	data: z
		.object({
			markdown: z.string().optional(),
			pages: z.array(firecrawlParsedPageSchema).optional(),
			metadata: z
				.object({
					numPages: z.number().int().nonnegative().optional(),
					totalPages: z.number().int().nonnegative().optional()
				})
				.nullish()
		})
		.optional()
});

export function parseFirecrawlParseResponse(
	responseText: string,
	responseBytes: number,
	pages = false
): FirecrawlParseSuccess | FirecrawlParseFailure {
	if (responseBytes > HOSTED_PARSE_MAX_OUTPUT_BYTES) {
		return { error: 'Firecrawl parse response is too large.' };
	}

	try {
		const parsed = firecrawlResponseSchema.safeParse(JSON.parse(responseText));

		if (!parsed.success) return { error: 'Firecrawl parse returned an invalid response.' };
		const payload = parsed.data;

		if (!payload.success)
			return { error: shortHostedParseError(payload.error?.trim() || 'Firecrawl parse failed.') };
		const metadata = payload.data?.metadata;

		if (
			metadata?.numPages !== undefined &&
			metadata.totalPages !== undefined &&
			metadata.totalPages > metadata.numPages
		) {
			return { error: 'Parsed document was truncated.' };
		}

		if (pages) {
			const parsedPages = payload.data?.pages;

			return parsedPages
				? { pages: parsedPages }
				: { error: 'Firecrawl parse did not return pages.' };
		}

		const markdown = payload.data?.markdown;

		if (!markdown?.trim()) return { error: 'Firecrawl parse did not return markdown.' };

		if (new TextEncoder().encode(markdown).byteLength > HOSTED_PARSE_MAX_OUTPUT_BYTES) {
			return { error: 'Firecrawl parse response is too large.' };
		}

		return { markdown };
	} catch {
		return { error: 'Firecrawl parse returned an invalid response.' };
	}
}

export async function readBoundedResponseBytes(
	response: Response,
	maxBytes: number
): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length'));

	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw new Error('Firecrawl parse response is too large.');
	}

	if (!response.body) {
		return new Uint8Array();
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;
		total += value.byteLength;

		if (total > maxBytes) {
			await reader.cancel();
			throw new Error('Firecrawl parse response is too large.');
		}

		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return bytes;
}
