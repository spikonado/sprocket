import { useEffect, useState } from 'react';
import { LocalResponseError } from '$lib/local/transport';
import type { LocalApi } from '$lib/types/sprocket';

/** Drops a saved thread cwd that no longer exists, like the agent does when its next run starts. */
export function useExistingThreadCwd(
	api: Pick<LocalApi, 'resolveWorkspacePath'> | null,
	cwd: string | undefined,
	// A run can recreate a missing cwd and set_cwd to the same path, so recheck when runs change.
	threadStatus: string | undefined
) {
	const [missingCwd, setMissingCwd] = useState<string | null>(null);

	useEffect(() => {
		if (!api || !cwd) return;

		let active = true;

		void (async () => {
			try {
				await api.resolveWorkspacePath({ workspacePath: cwd });

				if (active) setMissingCwd((missing) => (missing === cwd ? null : missing));
			} catch (error) {
				// Only the server's rejection proves the directory is gone; a dropped connection doesn't.
				if (active && error instanceof LocalResponseError && error.status === 400) {
					setMissingCwd(cwd);
				}
			}
		})();

		return () => {
			active = false;
		};
	}, [api, cwd, threadStatus]);

	return cwd === missingCwd ? undefined : cwd;
}
