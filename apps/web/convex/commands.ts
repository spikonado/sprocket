import { query } from '@convex/_generated/server';
import { v } from 'convex/values';

// Released hosts sync every local command until this reports it as finished.
export const get = query({
	args: { threadId: v.string(), sessionId: v.string() },
	handler: () => ({
		command: '',
		workdir: '',
		machineId: '',
		eventsBytes: 0,
		result: {
			output: '',
			success: false,
			running: false,
			timedOut: false,
			error: 'Sprocket no longer keeps command output on its servers.'
		}
	})
});
