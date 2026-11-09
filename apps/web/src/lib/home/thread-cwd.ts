import { useEffect, useState } from 'react';
import { isServerRejection } from '$lib/local/transport';
import type { LocalApi } from '$lib/types/sprocket';

export function useExistingThreadCwd(
	api: Pick<LocalApi, 'resolveWorkspacePath'> | null,
	cwd: string | undefined,
	recheckKey: string | undefined
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
				if (active && isServerRejection(error) && error.status === 400) {
					setMissingCwd(cwd);
				}
			}
		})();

		return () => {
			active = false;
		};
	}, [api, cwd, recheckKey]);

	return cwd === missingCwd ? undefined : cwd;
}
