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

// Lockfile and Nix integrity hashes are long and random but not secret, so they are matched
// whole and kept. `_` and `-` split other candidates so prefixed IDs such as `user_01KX…` stay
// intact.
const CANDIDATE = /(sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*)|(?<![\w+=])[A-Za-z0-9+=]{24,}/g;

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
		.replace(CANDIDATE, (token, hash?: string) =>
			!hash && isHighEntropy(token) ? placeholder('high-entropy') : token
		);
}

function redactJson(value: JsonValue): JsonValue {
	if (isJsonString(value)) return redactSecrets(value);

	if (Array.isArray(value)) return value.map(redactJson);

	if (isJsonObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]));
	}

	return value;
}

export function redactPrompt(prompt: TranscriptPromptBody): TranscriptPromptBody {
	return { ...prompt, text: redactSecrets(prompt.text) };
}

type CompletionItem = TranscriptCompletionBody['items'][number];

// Reasoning stays as the provider returned it, since providers replay it, and Claude rejects
// thinking whose signed text changed.
function redactCompletionItem(item: CompletionItem): CompletionItem {
	if (item.type === 'tool-call') return { ...item, input: redactJson(item.input) };

	if (item.type === 'reasoning') return item;

	return { ...item, text: redactSecrets(item.text) };
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
