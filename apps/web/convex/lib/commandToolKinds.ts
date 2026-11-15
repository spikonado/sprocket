const COMMAND_KINDS = new Set([
	'exec_cmd',
	'exec_command',
	'control_cmd',
	'control_command',
	'poll_cmd',
	'poll_command',
	'write_stdin'
]);

export function isCommandToolKind(kind: string): boolean {
	return COMMAND_KINDS.has(kind);
}
