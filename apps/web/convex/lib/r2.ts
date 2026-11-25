import { AwsClient } from 'aws4fetch';
import { ConvexError } from 'convex/values';
import { env } from '@convex/_generated/server';

const UPLOAD_URL_TTL_SECONDS = 60 * 60;

const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

function bucket() {
	const accountId = env.R2_ACCOUNT_ID?.trim();
	const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
	const name = env.R2_BUCKET?.trim();

	if (!accountId || !accessKeyId || !secretAccessKey || !name) {
		throw new ConvexError('File storage is not configured.');
	}

	return {
		client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
		url: `https://${accountId}.r2.cloudflarestorage.com/${name}`
	};
}

export function fileKey(userId: string, sha256: string): string {
	const deployment = new URL(env.CONVEX_CLOUD_URL).hostname.split('.')[0];

	return [deployment, 'files', userId, sha256].map(encodeURIComponent).join('/');
}

async function presign(
	key: string,
	init: {
		method: string;
		expiresIn: number;
		headers?: Record<string, string>;
		query?: Record<string, string>;
	}
): Promise<string> {
	const { client, url } = bucket();
	const target = new URL(`${url}/${key}`);
	target.searchParams.set('X-Amz-Expires', String(init.expiresIn));

	for (const [name, value] of Object.entries(init.query ?? {})) {
		target.searchParams.set(name, value);
	}

	const signed = await client.sign(target, {
		method: init.method,
		headers: init.headers,
		aws: { signQuery: true, allHeaders: true }
	});

	return signed.url;
}

function hexToBase64(hex: string): string {
	return btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map((byte) => parseInt(byte, 16))));
}

/** R2 rejects a PUT whose body doesn't match the signed length and checksum. */
export async function presignUpload(
	key: string,
	file: { size: number; sha256: string }
): Promise<{ url: string; headers: Record<string, string> }> {
	const headers = {
		'content-length': String(file.size),
		'x-amz-checksum-sha256': hexToBase64(file.sha256)
	};

	return {
		url: await presign(key, { method: 'PUT', expiresIn: UPLOAD_URL_TTL_SECONDS, headers }),
		headers
	};
}

export async function presignDownload(key: string): Promise<string> {
	return await presign(key, {
		method: 'GET',
		expiresIn: DOWNLOAD_URL_TTL_SECONDS,
		query: { 'response-content-disposition': 'attachment' }
	});
}

export async function deleteObject(key: string): Promise<void> {
	const { client, url } = bucket();
	const response = await client.fetch(`${url}/${key}`, { method: 'DELETE' });

	if (!response.ok && response.status !== 404) {
		throw new Error(`R2 delete failed with ${response.status}.`);
	}
}
