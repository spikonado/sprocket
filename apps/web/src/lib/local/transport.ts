import { z } from 'zod';

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

	return new LocalResponseError(
		parsed.data.error ? parsed.data.error : `Local request failed (${response.status}).`,
		response.status
	);
}

export class LocalResponseError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

async function requireSuccessfulResponse(response: Response, baseUrl: string): Promise<Response> {
	if (!response.ok) {
		throw await failedResponseError(response, baseUrl);
	}

	return response;
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
		}
	};
}
