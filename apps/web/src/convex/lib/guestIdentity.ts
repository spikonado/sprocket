const GUEST_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeGuestUserId(guestId?: string): string {
	const normalizedGuestId: string | undefined = guestId?.trim();
	if (!normalizedGuestId || !GUEST_ID_PATTERN.test(normalizedGuestId)) {
		throw new Error('Authentication required.');
	}

	return `guest:${normalizedGuestId.toLowerCase()}`;
}
