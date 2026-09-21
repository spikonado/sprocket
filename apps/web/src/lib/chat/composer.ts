type ComposerKeydownLike = Pick<KeyboardEvent, 'isComposing' | 'key' | 'shiftKey'>;

export function shouldSubmitComposerFromKeydown(event: ComposerKeydownLike) {
	return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

export function containsDraggedFiles(dataTransfer: Pick<DataTransfer, 'types'> | null) {
	return dataTransfer !== null && Array.from(dataTransfer.types).includes('Files');
}
