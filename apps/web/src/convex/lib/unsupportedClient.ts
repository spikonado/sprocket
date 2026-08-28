import { ConvexError } from 'convex/values';

/** ConvexError so production keeps the text on the UI, run banner, and agent stderr. */
export const UNSUPPORTED_CLIENT_MESSAGE =
	'This Sprocket version is no longer supported. Update to the latest Sprocket release.';

export function unsupportedClient(): never {
	throw new ConvexError(UNSUPPORTED_CLIENT_MESSAGE);
}
