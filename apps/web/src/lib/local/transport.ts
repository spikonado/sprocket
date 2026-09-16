import type { ArtifactsWatchRequest, TranscriptScopeRequest } from '$lib/types/sprocket';
import { z } from 'zod';

type LocalWatchRequest = TranscriptScopeRequest | ArtifactsWatchRequest;

const errorPayloadSchema = z.object({ error: z.string().optional() });

function unexpectedResponseError(body: string, baseUrl: string): Error {
	const preview = body.trim().slice(0, 120);
	if (preview.startsWith('<!')) {
		return new Error(
			`The Sprocket API at ${baseUrl} returned a web page instead of JSON. Make sure the server is running correctly.`
		);
	}
	return new Error(
		preview.length > 0
			? `Local API returned an unexpected response: ${preview}`
			: 'Local API returned an empty response.'
	);
}

async function parseJson<T>(response: Response, schema: z.ZodType<T>, baseUrl: string): Promise<T> {
	const body = await response.text();
	if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
		throw unexpectedResponseError(body, baseUrl);
	}

	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw unexpectedResponseError(body, baseUrl);
	}

	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new Error('Local API returned an unexpected response.');
	}
	return parsed.data;
}

async function failedResponseError(response: Response, baseUrl: string): Promise<Error> {
	const body = await response.text();
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return unexpectedResponseError(body, baseUrl);
	}
	const parsed = errorPayloadSchema.safeParse(json);
	if (!parsed.success) {
		return new Error('Local API returned an unexpected response.');
	}
	return new Error(
		parsed.data.error ? parsed.data.error : `Local request failed (${response.status}).`
	);
}

async function requireSuccessfulResponse(response: Response, baseUrl: string): Promise<Response> {
	if (!response.ok) {
		throw await failedResponseError(response, baseUrl);
	}
	return response;
}

function eventData(block: string): string | null {
	const data = block
		.split('\n')
		.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
		.filter((line) => line === 'data' || line.startsWith('data:'))
		.map((line) => (line === 'data' ? '' : line.slice(5).replace(/^ /, '')));
	return data.length > 0 ? data.join('\n') : null;
}

export async function readEventStream(
	response: Response,
	signal: AbortSignal,
	onData: (data: string) => void
): Promise<void> {
	if (!response.body) {
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
	signal.addEventListener('abort', cancel, { once: true });

	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });

			let match = /\r?\n\r?\n/.exec(buffer);
			while (match) {
				const data = eventData(buffer.slice(0, match.index));
				buffer = buffer.slice(match.index + match[0].length);
				if (data !== null && !signal.aborted) {
					onData(data);
				}
				match = /\r?\n\r?\n/.exec(buffer);
			}

			if (done) {
				break;
			}
		}
	} catch (error) {
		if (!signal.aborted) {
			throw error;
		}
	} finally {
		signal.removeEventListener('abort', cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export function createLocalTransport(baseUrl: string) {
	async function fetchLocal(pathname: string, init?: RequestInit): Promise<Response> {
		return await fetch(`${baseUrl}${pathname}`, {
			...init,
			credentials: 'include',
			headers: {
				'content-type': 'application/json',
				...init?.headers
			}
		});
	}

	return {
		async request<T>(pathname: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
			const response = await requireSuccessfulResponse(await fetchLocal(pathname, init), baseUrl);
			if (response.status === 204) {
				throw new Error('Local API returned an empty response.');
			}
			return await parseJson(response, schema, baseUrl);
		},

		async response(pathname: string, init?: RequestInit): Promise<Response> {
			return await requireSuccessfulResponse(await fetchLocal(pathname, init), baseUrl);
		},

		async postEventStream(
			pathname: string,
			requestBody: LocalWatchRequest,
			signal: AbortSignal,
			onData: (data: string) => void
		): Promise<void> {
			const response = await requireSuccessfulResponse(
				await fetchLocal(pathname, {
					method: 'POST',
					body: JSON.stringify(requestBody),
					signal
				}),
				baseUrl
			);
			await readEventStream(response, signal, onData);
		}
	};
}
