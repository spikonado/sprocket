import { useEffect } from 'react';
import { authState } from '$lib/auth';
import { useStore } from '$lib/store';
import CalmCentered from '$lib/components/home/calm-centered';

export default function Callback() {
	const { isReady } = useStore(authState);
	useEffect(() => {
		document.title = 'Signing In';
	}, []);
	useEffect(() => {
		if (isReady) window.location.replace('/');
	}, [isReady]);

	return (
		<CalmCentered
			title="Completing sign-in"
			description="Sprocket is finishing authentication and will return to your projects automatically."
		/>
	);
}
