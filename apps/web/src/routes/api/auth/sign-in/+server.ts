import { redirectToHostedAuthorization } from '$lib/server/hosted-request';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => redirectToHostedAuthorization(event, 'sign-in');
