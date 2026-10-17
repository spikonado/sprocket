import { v } from 'convex/values';
import { z } from 'zod';
import type { Document } from 'firecrawl';
import type { Id } from '@convex/_generated/dataModel';
import type { QueryCtx, MutationCtx } from '@convex/_generated/server';
import { MAX_FILE_NAME_LENGTH } from '@convex/lib/validators';

export const HOSTED_PARSE_MAX_INPUT_BYTES = 50_000_000;

export const HOSTED_PARSE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const HOSTED_PARSE_TTL_MS = 60 * 60 * 1_000;

export const HOSTED_PARSE_ERROR_MAX_CHARS = 500;

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
		formats: ['markdown' as const],
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

const firecrawlParseDocumentSchema = z.object({
	markdown: z.string().nullish(),
	pages: z.array(firecrawlParsedPageSchema).nullish(),
	metadata: z
		.object({
			numPages: z.number().int().nonnegative().optional(),
			totalPages: z.number().int().nonnegative().optional()
		})
		.nullish()
});

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** Validates the document returned by the Firecrawl SDK's `parse`. */
export function parseFirecrawlParseDocument(
	document: Document,
	pages = false
): FirecrawlParseSuccess | FirecrawlParseFailure {
	const parsed = firecrawlParseDocumentSchema.safeParse(document);

	if (!parsed.success) return { error: 'Firecrawl parse returned an invalid response.' };
	const { metadata } = parsed.data;

	if (
		metadata?.numPages !== undefined &&
		metadata.totalPages !== undefined &&
		metadata.totalPages > metadata.numPages
	) {
		return { error: 'Parsed document was truncated.' };
	}

	if (pages) {
		const parsedPages = parsed.data.pages;

		if (!parsedPages) return { error: 'Firecrawl parse did not return pages.' };

		// executeHostedParse stores, and the agent downloads, this exact serialization.
		if (utf8Bytes(JSON.stringify({ pages: parsedPages })) > HOSTED_PARSE_MAX_OUTPUT_BYTES) {
			return { error: 'Firecrawl parse response is too large.' };
		}

		return { pages: parsedPages };
	}

	const markdown = parsed.data.markdown;

	if (!markdown?.trim()) return { error: 'Firecrawl parse did not return markdown.' };

	if (utf8Bytes(markdown) > HOSTED_PARSE_MAX_OUTPUT_BYTES) {
		return { error: 'Firecrawl parse response is too large.' };
	}

	return { markdown };
}

export class ResponseTooLargeError extends Error {
	constructor() {
		super('Firecrawl parse response is too large.');
	}
}

export async function readBoundedResponseBytes(
	response: Response,
	maxBytes: number
): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length'));

	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw new ResponseTooLargeError();
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
			throw new ResponseTooLargeError();
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
