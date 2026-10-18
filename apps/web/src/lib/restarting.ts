import { useEffect, useState } from 'react';

export function useIsRestarting(restartingUntil: number | undefined): boolean {
	const [now, setNow] = useState(Date.now);

	useEffect(() => {
		if (restartingUntil === undefined) return;
		setNow(Date.now());
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, restartingUntil - Date.now()));

		return () => clearTimeout(timer);
	}, [restartingUntil]);

	return restartingUntil !== undefined && now < restartingUntil;
}
