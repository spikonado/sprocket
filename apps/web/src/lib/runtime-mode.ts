const HOSTED_WEB_API_PATHS = new Set([
	'/api/config',
	'/api/auth/sign-in',
	'/api/auth/sign-up',
	'/api/auth/callback',
	'/api/auth/session/token',
	'/api/auth/sign-out'
]);

export function hostedWebFromPublicFlag(value: string | undefined): boolean {
	return value === 'true';
}

export const isHostedWeb = hostedWebFromPublicFlag(import.meta.env.PUBLIC_SPROCKET_HOSTED);

export function isHostedWebApiPath(pathname: string): boolean {
	return HOSTED_WEB_API_PATHS.has(pathname);
}
