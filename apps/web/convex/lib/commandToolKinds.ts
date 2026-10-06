const EXEC_COMMAND_KINDS = new Set(['exec_cmd', 'exec_command']);

const SESSION_COMMAND_KINDS = new Set([
	'control_cmd',
	'control_command',
	'poll_cmd',
	'poll_command',
	'write_stdin'
]);

/** Includes current tool names and aliases retained in stored transcripts. */
export function isExecCommandToolKind(kind: string): boolean {
	return EXEC_COMMAND_KINDS.has(kind);
}

export function isSessionCommandToolKind(kind: string): boolean {
	return SESSION_COMMAND_KINDS.has(kind);
}

export function isCommandToolKind(kind: string): boolean {
	return isExecCommandToolKind(kind) || isSessionCommandToolKind(kind);
}
