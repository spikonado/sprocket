import type { Id } from '$convex/_generated/dataModel';

/** The right sidebar shows the agent's browser live view alongside thread
 * artifacts; the live tab is selected automatically when browsing starts. */
export type SidePanelTab = 'live' | 'artifacts';

/** Stored panel state, restored when revisiting a thread. */
export type SidePanelSnapshot = {
	open: boolean;
	/** When true, the panel covers the full Sprocket workspace UI. */
	expanded: boolean;
	tab: SidePanelTab;
	/** Selected artifact, for the artifacts tab. */
	selectedKey: string | null;
};

export const DEFAULT_SIDE_PANEL_SNAPSHOT: SidePanelSnapshot = {
	open: false,
	expanded: false,
	tab: 'artifacts',
	selectedKey: null
};

/** Live-view state for the thread's shared browser session. */
export type BrowserLiveViewState = {
	/** Embeddable watch-only live view URL; null while it is being set up. */
	url: string | null;
	/** Interactive variant. Load it only after humanControl is true. */
	interactiveUrl?: string | null;
	/** Whether this session persists cookies and login state. */
	saving?: boolean;
	/** Hard deadline for the Firecrawl session. */
	expiresAt?: number;
	/** True after the user takes control; agent browser calls are blocked. */
	humanControl?: boolean;
	/** Present for Firecrawl sessions that support takeover. Absent on
	 * legacy Browserbase sessions, which stay watch-only. */
	threadId?: Id<'threadRecords'>;
	/** Run that most recently drove the browser; matched against the active run
	 * for liveness and auto-open. */
	lastUsedRunId: Id<'runs'> | null;
	/** Session (re)start time. */
	startedAt: number;
};
