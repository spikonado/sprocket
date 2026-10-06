import { useEffect, useState } from 'react';

export function useMobileSelector() {
	const [mobile, setMobile] = useState(
		() => window.matchMedia?.('(max-width: 639px)').matches ?? false
	);

	useEffect(() => {
		const media = window.matchMedia?.('(max-width: 639px)');

		if (!media) return;

		function update() {
			setMobile(media.matches);
		}

		update();
		media.addEventListener?.('change', update);

		return () => media.removeEventListener?.('change', update);
	}, []);

	return mobile;
}
