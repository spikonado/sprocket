import type { Handle } from '@sveltejs/kit';
import { isHostedWeb, isHostedWebApiPath } from '$lib/runtime-mode';

export const handle: Handle = async ({ event, resolve }) => {
	if (isHostedWebApiPath(event.url.pathname) && !isHostedWeb) {
		return new Response(JSON.stringify({ error: 'Not found' }), {
			status: 404,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store'
			}
		});
	}

	const response = await resolve(event);
	if (isHostedWeb && isHostedWebApiPath(event.url.pathname)) {
		response.headers.set('cache-control', 'no-store');
	}
	return response;
};
