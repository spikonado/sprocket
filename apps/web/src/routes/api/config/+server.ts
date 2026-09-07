import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { isHostedWeb } from '$lib/runtime-mode';
import { publicRuntimeEnv } from '$lib/server/hosted-config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	if (!isHostedWeb) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	return json({ env: publicRuntimeEnv(env) });
};
