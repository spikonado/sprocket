type ComposerKeydownLike = Pick<KeyboardEvent, 'isComposing' | 'key' | 'shiftKey'>;

export function shouldSubmitComposerFromKeydown(event: ComposerKeydownLike) {
	return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}
