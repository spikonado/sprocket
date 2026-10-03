import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, RunningCommand, TranscriptScopeRequest } from '$lib/types/sprocket';

export type CommandApi = Pick<DesktopApi, 'listRunningCommands' | 'terminateCommand'>;

type CommandLifetime = {
	api: CommandApi;
	userId: string;
	threadId: TranscriptScopeRequest['threadId'];
	controller: AbortController;
	stopping: Set<string>;
};

type CommandState = {
	lifetime: CommandLifetime;
	commands: RunningCommand[];
	refreshError: string | null;
	stopError: { sessionId: string; message: string } | null;
	stopping: string[];
};

export function useRunningCommands(api: CommandApi, { userId, threadId }: TranscriptScopeRequest) {
	const [state, setState] = useState<CommandState | null>(null);
	const lifetime = useRef<CommandLifetime | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		const active = { api, userId, threadId, controller, stopping: new Set<string>() };
		lifetime.current = active;
		let timer: ReturnType<typeof setTimeout>;

		async function refresh() {
			try {
				const { commands } = await api.listRunningCommands({ userId, threadId }, controller.signal);

				if (!controller.signal.aborted) {
					setState((previous) => ({
						lifetime: active,
						commands,
						refreshError: null,
						stopError:
							previous?.lifetime === active &&
							commands.some((command) => command.sessionId === previous.stopError?.sessionId)
								? previous.stopError
								: null,
						stopping: [...active.stopping]
					}));
				}
			} catch {
				if (!controller.signal.aborted) {
					setState((previous) =>
						previous?.lifetime === active
							? { ...previous, refreshError: 'Unable to refresh running commands. Reconnecting…' }
							: null
					);
				}
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(refresh, 1_000);
			}
		}

		void refresh();

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [api, userId, threadId]);

	const current =
		state?.lifetime.api === api &&
		state.lifetime.userId === userId &&
		state.lifetime.threadId === threadId &&
		!state.lifetime.controller.signal.aborted
			? state
			: null;

	async function terminate(sessionId: string) {
		const active = lifetime.current;

		if (
			!active ||
			active.api !== api ||
			active.userId !== userId ||
			active.threadId !== threadId ||
			active.controller.signal.aborted ||
			active.stopping.has(sessionId) ||
			!current?.commands.some((command) => command.sessionId === sessionId)
		)
			return;
		active.stopping.add(sessionId);
		setState((previous) =>
			previous?.lifetime === active
				? { ...previous, stopping: [...active.stopping], stopError: null }
				: previous
		);

		try {
			await api.terminateCommand({ userId, threadId, sessionId });
		} catch (error) {
			if (!active.controller.signal.aborted)
				setState((previous) =>
					previous?.lifetime === active
						? {
								...previous,
								stopError: {
									sessionId,
									message: error instanceof Error ? error.message : 'Unable to stop command.'
								}
							}
						: previous
				);
		} finally {
			active.stopping.delete(sessionId);

			if (!active.controller.signal.aborted)
				setState((previous) =>
					previous?.lifetime === active ? { ...previous, stopping: [...active.stopping] } : previous
				);
		}
	}

	return {
		commands: current?.commands ?? [],
		error: current?.stopError?.message ?? current?.refreshError ?? null,
		stopping: current?.stopping ?? [],
		terminate
	};
}
