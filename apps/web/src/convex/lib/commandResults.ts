import { isJsonObject, isJsonString, type JsonValue } from '@convex/lib/json';
import type { ExecutorJobResult } from '@convex/lib/validators';

const commandKinds = new Set(['exec_command', 'write_stdin']);

export function removeLegacyCommandStreams(kind: string, result: JsonValue): JsonValue {
	if (!commandKinds.has(kind) || !isJsonObject(result) || !isJsonString(result.output)) {
		return result;
	}
	if (!Object.hasOwn(result, 'stdout') && !Object.hasOwn(result, 'stderr')) return result;

	const current = { ...result };
	delete current.stdout;
	delete current.stderr;
	return current;
}

export function normalizeExecutorJobResult(
	kind: string,
	result: ExecutorJobResult
): ExecutorJobResult {
	// SAFETY: only legacy command-only fields are removed from the command result union member.
	return removeLegacyCommandStreams(kind, result) as ExecutorJobResult;
}
