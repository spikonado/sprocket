import { useEffect, useState } from 'react';
import type { LocalApi } from '$lib/types/sprocket';

/** Drops a saved thread cwd that no longer exists, like the agent does when its next run starts. */
export function useExistingThreadCwd(
	api: Pick<LocalApi, 'resolveWorkspacePath'> | null,
	cwd: string | undefined
) {
	const [missingCwd, setMissingCwd] = useState<string | null>(null);

	useEffect(() => {
		if (!api || !cwd) return;

		let active = true;

		api.resolveWorkspacePath({ workspacePath: cwd }).then(
			() => active && setMissingCwd((missing) => (missing === cwd ? null : missing)),
			() => active && setMissingCwd(cwd)
		);

		return () => {
			active = false;
		};
	}, [api, cwd]);

	return cwd === missingCwd ? undefined : cwd;
}
