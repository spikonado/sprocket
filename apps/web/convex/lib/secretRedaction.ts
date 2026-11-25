import type {
	TranscriptCompletionBody,
	TranscriptPromptBody,
	TranscriptToolBody
} from '@convex/lib/validators';
import { isJsonObject, isJsonString, type JsonValue } from '@convex/lib/json';

// Each pattern may start only at the beginning of a token run, or after a diff marker such as
// `-sk-…`. A `\b` start goes quadratic on inputs like `eyJ-eyJ-…`, where every prefix rescans
// the rest of the run.
const KNOWN_FORMATS: [label: string, pattern: RegExp][] = [
	[
		'private-key',
		/-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,20}PRIVATE KEY-----/g
	],
	['jwt', /(?<!\w|\S-)eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g],
	['anthropic-key', /(?<!\w|\S-)sk-ant-[\w-]{20,}/g],
	['openai-key', /(?<!\w|\S-)sk-(?:proj-|svcacct-|admin-)?[\w-]{20,}/g],
	['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/g],
	['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
	['google-api-key', /\bAIza[\w-]{35}/g],
	['slack-token', /(?<!\w|\S-)xox[abposr]-[A-Za-z0-9-]{10,}/g],
	['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g]
];

const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,256}:)([^\s/@]{1,256})@/gi;

const SECRET_NAME = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key/i;

const SECRET_ASSIGNMENT = new RegExp(
	`(\\b[\\w-]{0,40}(?:${SECRET_NAME.source})[\\w-]{0,40}["']?\\s{0,8}[:=]\\s{0,8}["']?|\\bBearer\\s{1,8})([^\\s"'\`,;)]{8,})`,
	'gi'
);

// `_` and `-` split candidates so prefixed IDs such as `user_01KX…` stay intact. Lockfile and
// Nix hashes are long and random but not secret.
const CANDIDATE = /(?<!sha(?:1|256|384|512)-)(?<![\w+=])[A-Za-z0-9+=]{24,}/g;

function placeholder(label: string): string {
	return `[redacted:${label}]`;
}

function entropy(text: string): number {
	const counts = new Map<string, number>();

	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;

	for (const count of counts.values()) {
		const share = count / text.length;
		bits -= share * Math.log2(share);
	}

	return bits;
}

function digitCount(text: string): number {
	return text.replace(/\D/g, '').length;
}

function isAssignedSecret(value: string): boolean {
	return digitCount(value) > 0 && /[A-Za-z]/.test(value) && entropy(value) >= 3;
}

// Requiring mixed case and digits keeps commit SHAs, Convex IDs, ULIDs and UUIDs intact.
// The entropy bar follows the length because random strings gain entropy with length and
// identifiers made of words don't.
function isHighEntropy(token: string): boolean {
	return (
		/[a-z]/.test(token) &&
		/[A-Z]/.test(token) &&
		digitCount(token) >= 2 &&
		entropy(token) >= Math.min(Math.log2(token.length) - 0.6, 4.5)
	);
}

export function redactSecrets(text: string): string {
	let redacted = text;

	for (const [label, pattern] of KNOWN_FORMATS) {
		redacted = redacted.replace(pattern, placeholder(label));
	}

	return redacted
		.replace(URL_PASSWORD, (_match, prefix: string) => `${prefix}${placeholder('password')}@`)
		.replace(SECRET_ASSIGNMENT, (match, prefix: string, value: string) =>
			isAssignedSecret(value) ? `${prefix}${placeholder('secret')}` : match
		)
		.replace(CANDIDATE, (token) => (isHighEntropy(token) ? placeholder('high-entropy') : token));
}

function redactJson(value: JsonValue, key?: string): JsonValue {
	if (isJsonString(value) && key && SECRET_NAME.test(key) && isAssignedSecret(value)) {
		return placeholder('secret');
	}

	if (isJsonString(value)) return redactSecrets(value);

	if (Array.isArray(value)) return value.map((item) => redactJson(item));

	if (isJsonObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [name, redactJson(item, name)])
		);
	}

	return value;
}

export function redactPrompt(prompt: TranscriptPromptBody): TranscriptPromptBody {
	return { ...prompt, text: redactSecrets(prompt.text) };
}

function isSignedThinking(metadata: JsonValue | undefined): boolean {
	if (!metadata || !isJsonObject(metadata)) return false;

	const native = metadata.rigNative;

	return !!native && isJsonObject(native) && native.type === 'thinking';
}

type CompletionItem = TranscriptCompletionBody['items'][number];

// IDs and providerMetadata stay as sent, since providers replay encrypted reasoning from them.
// Claude signs its thinking text, so a redacted thinking item drops its signature and replays
// as plain text.
function redactCompletionItem(item: CompletionItem): CompletionItem {
	if (item.type === 'tool-call') return { ...item, input: redactJson(item.input) };

	const text = redactSecrets(item.text);

	if (text === item.text) return item;
	const redacted = { ...item, text };

	if (item.type === 'reasoning' && isSignedThinking(item.providerMetadata)) {
		delete redacted.providerMetadata;
	}

	return redacted;
}

export function redactCompletion(completion: TranscriptCompletionBody): TranscriptCompletionBody {
	return { ...completion, items: completion.items.map(redactCompletionItem) };
}

export function redactTool(tool: TranscriptToolBody): TranscriptToolBody {
	const redacted = { ...tool };

	if (tool.input !== undefined) redacted.input = redactJson(tool.input);

	if (tool.output !== undefined) redacted.output = redactJson(tool.output);

	return redacted;
}
