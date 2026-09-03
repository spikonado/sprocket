import { z } from 'zod';
import { GATEWAY_TOKEN_PREFIX, GATEWAY_TOKEN_TTL_MS } from '@convex/lib/gatewayProtocol';

const gatewayTokenPayloadSchema = z.object({
	v: z.literal(1),
	userId: z.string(),
	exp: z.int()
});

export type GatewayTokenPayload = z.infer<typeof gatewayTokenPayloadSchema>;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/');
	const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
	let binary: string;
	try {
		binary = atob(`${padded}${pad}`);
	} catch {
		throw new Error('Invalid gateway token.');
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

export function gatewayTokenExpiresAt(now = Date.now()): number {
	return now + GATEWAY_TOKEN_TTL_MS;
}

export async function mintGatewayToken(
	secret: string,
	payload: GatewayTokenPayload
): Promise<string> {
	const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = new Uint8Array(
		await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body))
	);
	return `${GATEWAY_TOKEN_PREFIX}.${body}.${bytesToBase64Url(signature)}`;
}

export async function verifyGatewayToken(
	secret: string,
	token: string,
	now = Date.now()
): Promise<GatewayTokenPayload> {
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== GATEWAY_TOKEN_PREFIX) {
		throw new Error('Invalid gateway token.');
	}
	const [, body, signaturePart] = parts;
	if (!body || !signaturePart) {
		throw new Error('Invalid gateway token.');
	}
	const expected = new Uint8Array(
		await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body))
	);
	if (!constantTimeEqual(expected, base64UrlToBytes(signaturePart))) {
		throw new Error('Invalid gateway token.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
	} catch {
		throw new Error('Invalid gateway token.');
	}
	const payload = gatewayTokenPayloadSchema.safeParse(parsed);
	if (!payload.success) {
		throw new Error('Invalid gateway token.');
	}
	if (payload.data.exp <= now) {
		throw new Error('Gateway token expired.');
	}
	return payload.data;
}
