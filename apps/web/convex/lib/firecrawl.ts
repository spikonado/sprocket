import { z } from 'zod';
import { env } from '@convex/_generated/server';
import { MAX_FILE_NAME_LENGTH } from '@convex/lib/validators';

export const FIRECRAWL_CREDITS_EXHAUSTED = 'Firecrawl credits are exhausted.';

export const PARSE_MAX_INPUT_BYTES = 50_000_000;

const PARSE_URL = 'https://api.firecrawl.dev/v2/parse';

const PARSE_TIMEOUT_MS = 300_000;

/** Lets Firecrawl report its own timeout before the connection is dropped. */
const PARSE_CONNECTION_MARGIN_MS = 30_000;

const PDF_PARSER = { type: 'pdf', mode: 'auto' } as const;

const errorBodySchema = z.object({
	error: z.string().optional(),
	message: z.string().optional()
});

export function parseUploadFilename(filename: string): string | null {
	const base = filename.trim().split(/[/\\]/).pop()?.trim() ?? '';

	if (!base || base.length > MAX_FILE_NAME_LENGTH) return null;

	return base;
}

/** Streams the upload into Firecrawl's multipart parse endpoint and returns its unread response. */
export async function requestFirecrawlParse(file: {
	body: ReadableStream<Uint8Array>;
	size: number;
	filename: string;
	pages: boolean;
}): Promise<Response> {
	const apiKey = env.FIRECRAWL_API_KEY?.trim();

	if (!apiKey) throw new Error('FIRECRAWL_API_KEY is not configured.');

	const boundary = `sprocket-${crypto.randomUUID()}`;

	const options = {
		formats: ['markdown'],
		parsers: [file.pages ? { ...PDF_PARSER, pages: true } : PDF_PARSER],
		timeout: PARSE_TIMEOUT_MS
	};

	const mediaType = file.filename.toLowerCase().endsWith('.pdf')
		? 'application/pdf'
		: 'application/octet-stream';

	const encoder = new TextEncoder();

	const head = encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(options)}\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${multipartFilename(file.filename)}"\r\nContent-Type: ${mediaType}\r\n\r\n`
	);

	const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

	const init: RequestInit & { duplex: 'half' } = {
		method: 'POST',
		headers: {
			authorization: `Bearer ${apiKey}`,
			'content-type': `multipart/form-data; boundary=${boundary}`,
			'content-length': String(head.byteLength + file.size + tail.byteLength)
		},
		body: framedStream(head, file.body, tail),
		duplex: 'half',
		signal: AbortSignal.timeout(PARSE_TIMEOUT_MS + PARSE_CONNECTION_MARGIN_MS)
	};

	const response = await fetch(PARSE_URL, init);

	if (!response.ok) throw await firecrawlFailure(response);

	return response;
}

function multipartFilename(filename: string): string {
	return filename.replace(/["\r\n]/g, (character) => encodeURIComponent(character));
}

function framedStream(
	head: Uint8Array,
	body: ReadableStream<Uint8Array>,
	tail: Uint8Array
): ReadableStream<Uint8Array> {
	const reader = body.getReader();

	return new ReadableStream({
		start: (controller) => controller.enqueue(head),
		pull: async (controller) => {
			const { done, value } = await reader.read();

			if (!done) return controller.enqueue(value);
			controller.enqueue(tail);
			controller.close();
		},
		cancel: async (reason) => await reader.cancel(reason)
	});
}

async function firecrawlFailure(response: Response): Promise<Error> {
	if (response.status === 402) return new Error(FIRECRAWL_CREDITS_EXHAUSTED);

	const body = errorBodySchema.safeParse(await response.json().catch(() => null)).data;
	const detail = (body?.error ?? body?.message)?.trim();

	if (response.status === 400 && detail) return new Error(detail);

	return new Error(
		detail
			? `Firecrawl parse failed (${response.status}): ${detail}`
			: `Firecrawl parse failed (${response.status}).`
	);
}
