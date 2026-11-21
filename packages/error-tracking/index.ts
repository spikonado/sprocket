type ExceptionList = { stacktrace?: { frames?: { in_app?: boolean }[] } }[];

/**
 * A PostHog `before_send` that drops exceptions without a stack frame from a web page script,
 * such as the "Script error." browsers report for cross-origin scripts and stackless
 * DOMExceptions. Neither points at code.
 */
export function dropExceptionsOutsideApp<
	Event extends { event: string; properties: { $exception_list?: ExceptionList } }
>(event: Event): Event | null {
	if (event.event !== '$exception') return event;

	return event.properties.$exception_list?.some(({ stacktrace }) =>
		stacktrace?.frames?.some((frame) => frame.in_app)
	)
		? event
		: null;
}
