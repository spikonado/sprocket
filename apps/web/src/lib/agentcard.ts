const POPUP_NAME = 'agentcard';

const POPUP_FEATURES = 'popup,width=480,height=760';

export function openAgentcardPopup(url: string) {
	window.open(url, POPUP_NAME, POPUP_FEATURES);
}

/** Opens the popup inside the click so browsers allow it, then points it at the Vault page. */
export async function openCardLinkPopup(createCardLink: () => Promise<{ url: string }>) {
	const popup = window.open('', POPUP_NAME, POPUP_FEATURES);

	if (!popup) throw new Error('Allow pop-ups for Sprocket to add a card.');

	try {
		const { url } = await createCardLink();
		popup.location.href = url;
	} catch (error) {
		popup.close();
		throw error;
	}
}
