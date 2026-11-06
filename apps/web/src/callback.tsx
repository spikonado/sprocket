import { useEffect } from 'react';
import { authState } from '$lib/auth';
import { useStore } from '$lib/store';
import CalmCentered from '$lib/components/home/calm-centered';
import Button from '$lib/components/ui/button/button';

export default function Callback() {
	const { isReady, error } = useStore(authState);
	useEffect(() => {
		document.title = 'Signing In';
	}, []);
	useEffect(() => {
		if (isReady && !error) window.location.replace('/');
	}, [isReady, error]);

	if (isReady && error) {
		return (
			<CalmCentered
				title="Sign-in didn’t finish"
				description={error}
				actions={<Button onclick={() => window.location.replace('/')}>Back to Sprocket</Button>}
			/>
		);
	}

	return (
		<CalmCentered
			title="Completing sign-in"
			description="Sprocket is finishing authentication and will return to your projects automatically."
		/>
	);
}
