import { useEffect, useEffectEvent, useState } from 'react';
import type { ConvexReactClient } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useStore } from '$lib/store';
import type { AgentRunStart, DesktopApi } from '$lib/types/sprocket';
import { MessageQueue } from './message-queue';

export function useMessageQueue({
	client,
	desktopApi,
	userId,
	onStarted
}: {
	client: ConvexReactClient;
	desktopApi: DesktopApi | null;
	userId: string | null;
	onStarted: (started: AgentRunStart) => void;
}) {
	const [queue] = useState(() => new MessageQueue());
	const messages = useStore(queue);
	const handleStarted = useEffectEvent(onStarted);

	useEffect(() => {
		if (!desktopApi || !userId) {
			queue.setContext(null);

			return;
		}

		queue.setContext({
			userId,
			api: desktopApi,
			onStarted: (started) => handleStarted(started),
			watchLifecycle: (threadId, onUpdate, onError) => {
				const watch = client.watchQuery(api.chat.selectedThreadLifecycle, { threadId });

				const report = () => {
					try {
						const lifecycle = watch.localQueryResult();

						if (lifecycle !== undefined) onUpdate(lifecycle);
					} catch (error) {
						onError(error instanceof Error ? error : new Error(String(error)));
					}
				};

				const stop = watch.onUpdate(report);
				report();

				return stop;
			}
		});

		return () => queue.setContext(null);
	}, [client, desktopApi, userId, queue]);

	return { queue, messages };
}
