import {
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useState,
	type ComponentProps
} from 'react';
import type { Doc, Id } from '@convex/_generated/dataModel';
import ArtifactScreenFullscreen, {
	requestArtifactFullscreen
} from '$lib/components/home/artifact-screen-fullscreen';
import ConversationNotices from '$lib/components/home/conversation-notices';
import CreateThreadHeading from '$lib/components/home/create-thread-heading';
import InboxSidebar, { type SidebarChildrenResolver } from '$lib/components/home/inbox-sidebar';
import PromptComposer from '$lib/components/home/prompt-composer';
import PurchaseApprovals from '$lib/components/home/purchase-approvals';
import RunUsageFooter from '$lib/components/home/run-usage-footer';
import SidePanel from '$lib/components/home/side-panel';
import ThreadTranscript from '$lib/components/home/thread-transcript';
import '$lib/components/home/create-thread.css';
import '$lib/components/home/inbox.css';
import {
	MarkdownFileLinksContext,
	openMarkdownLink,
	type MarkdownFileLinks
} from '$lib/chat/markdown-file-links';
import { convexId } from '$lib/convex-id';
import { useArtifactPanel } from '$lib/home/artifact-panel';
import { useTranscriptStore } from '$lib/home/transcript-store';
import {
	useExpandedThreads,
	type ThreadTreeSummaryRead,
	type UseExpandedThreads
} from '$lib/project/useThreadTree';
import { useLatest } from '$lib/use-latest';
import { useStore } from '$lib/store';
import { applyTheme, type SprocketTheme } from '$lib/theme';
import { cn } from '$lib/utils';
import { isWorking, type DemoState } from './demo-state';
import { projects } from './fixtures/projects';
import { workspaceApi } from './workspace-api';
import './demo.css';

type Thread = Doc<'threadRecords'>;

const workspaces = projects.map((demo) => ({ ...demo, filesApi: workspaceApi(demo.workspace) }));
const projectList = projects.map((demo) => demo.project);
const NARROW = '(max-width: 767px)';

function workspaceFor(repositoryKey: string) {
	return workspaces.find((demo) => demo.project.repositoryKey === repositoryKey) ?? workspaces[0];
}

function treeSummaryReader(state: DemoState): ThreadTreeSummaryRead {
	return function useDemoTreeSummary({ threadId }) {
		useStore(state);

		return threadId ? state.treeSummary(threadId) : undefined;
	};
}

function DemoThreadChildren({
	state,
	expansion,
	threadId,
	renderRows
}: Parameters<SidebarChildrenResolver>[0] & { state: DemoState; expansion: UseExpandedThreads }) {
	useStore(state);
	const rows = state.children(threadId);

	useEffect(() => {
		expansion.registerChildren(threadId, rows);
	}, [expansion, threadId, rows]);

	return renderRows(rows);
}

type SidebarProps = ComponentProps<typeof InboxSidebar>;

function DemoSidebar({
	state,
	...props
}: Omit<SidebarProps, 'expansion' | 'resolveChildren' | 'readTreeSummary'> & { state: DemoState }) {
	const expansion = useExpandedThreads(null);
	const [readTreeSummary] = useState(() => treeSummaryReader(state));

	const reveal = useEffectEvent((threadId: Id<'threadRecords'> | null) => {
		const parentId = threadId ? state.record(threadId)?.parentThreadId : undefined;
		const roots = props.sections.flatMap((section) => section.rows);

		expansion.revealAncestors([
			...roots.filter((root) => state.children(root._id).length > 0).map((root) => root._id),
			...(parentId ? [parentId] : [])
		]);
	});

	useEffect(() => reveal(props.currentThreadId), [props.currentThreadId]);

	const resolveChildren: SidebarChildrenResolver = useCallback(
		({ threadId, renderRows }) => (
			<DemoThreadChildren
				state={state}
				expansion={expansion}
				threadId={threadId}
				renderRows={renderRows}
			/>
		),
		[state, expansion]
	);

	return (
		<InboxSidebar
			{...props}
			expansion={expansion}
			resolveChildren={resolveChildren}
			readTreeSummary={readTreeSummary}
		/>
	);
}

type ModelSelection = { model?: string; effort?: string };

/** A new thread's model is left unset, so the composer picks the catalog's default once it loads. */
function modelSelection(record: Thread | undefined): ModelSelection {
	return { model: record?.selectedModel, effort: record?.reasoningEffort };
}

export default function DemoApp({
	state,
	initialThreadId,
	initialTheme
}: {
	state: DemoState;
	initialThreadId: Id<'threadRecords'>;
	initialTheme: SprocketTheme;
}) {
	useStore(state);
	const transcript = useTranscriptStore();
	const artifactPanel = useArtifactPanel();

	const [currentThreadId, setCurrentThreadId] = useState<Id<'threadRecords'> | null>(
		initialThreadId
	);

	const currentThreadIdRef = useLatest(currentThreadId);
	const [theme, setTheme] = useState(initialTheme);
	const [settledOpen, setSettledOpen] = useState(false);
	const [search, setSearch] = useState('');
	const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
	const [sidebarOpen, setSidebarOpen] = useState(!narrow);
	const [prompt, setPrompt] = useState('');
	const [selectedQuestionOptionId, setSelectedQuestionOptionId] = useState<string | null>(null);
	const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
	const [newThreadProject, setNewThreadProject] = useState(projectList[0].repositoryKey);

	const [artifactFullscreenRequest, setArtifactFullscreenRequest] =
		useState<Promise<boolean> | null>(null);

	const record = currentThreadId ? state.record(currentThreadId) : undefined;
	const repositoryKey = record?.repositoryKey ?? newThreadProject;
	const { project, artifacts, artifactContents, filesApi } = workspaceFor(repositoryKey);

	const run = currentThreadId ? state.run(currentThreadId) : null;
	const working = run !== null && isWorking(run);
	const pendingQuestion = run?.status === 'waiting' ? run.question : null;
	const catalog = state.catalog;
	const modelCatalog = catalog.status === 'ready' ? catalog.catalog : undefined;

	const [selection, setSelection] = useState(() => ({
		threadId: currentThreadId,
		...modelSelection(record)
	}));

	if (selection.threadId !== currentThreadId) {
		setSelection({ threadId: currentThreadId, ...modelSelection(record) });
	}

	const fullscreenArtifact =
		artifacts.find((artifact) => artifact.key === artifactPanel.fullscreenKey) ?? null;

	useEffect(() => {
		const media = matchMedia(NARROW);
		const updateNarrow = () => setNarrow(media.matches);
		media.addEventListener('change', updateNarrow);

		return () => media.removeEventListener('change', updateNarrow);
	}, []);

	useEffect(() => {
		if (transcript.threadId !== currentThreadId) transcript.selectThread(currentThreadId);

		if (!currentThreadId) return;
		state.open(currentThreadId);

		return transcript.watch({
			api: state.transcripts,
			userId: state.userId,
			threadId: currentThreadId,
			isCurrent: () => currentThreadIdRef.current === currentThreadId
		});
	}, [currentThreadId, currentThreadIdRef, state, transcript]);

	useLayoutEffect(() => {
		artifactPanel.selectScope(
			{
				userId: state.userId,
				repositoryKey: project.repositoryKey,
				workspacePath: project.workspacePath
			},
			currentThreadId
		);
	}, [artifactPanel, state, currentThreadId, project]);

	const markdownFileLinks = useMemo<MarkdownFileLinks>(() => {
		const workspace = workspaceFor(repositoryKey);
		const roots = [workspace.project.workspacePath];

		return {
			roots,
			open: (target) => {
				artifactPanel.setFullscreenKey(null);
				void openMarkdownLink(target, {
					roots,
					entryKind: (entry) => workspace.filesApi.workspaceEntryKind(entry),
					openFile: (file) => artifactPanel.openFile(file),
					openDirectory: (directory) => artifactPanel.openDirectory(directory)
				});
			}
		};
	}, [artifactPanel, repositoryKey]);

	function selectThread(threadId: Id<'threadRecords'> | null) {
		setCurrentThreadId(threadId);
		setPrompt('');
		setSelectedQuestionOptionId(null);

		if (narrow) setSidebarOpen(false);
	}

	function changeTheme(next: SprocketTheme) {
		applyTheme(next);
		setTheme(next);
	}

	function submit() {
		if (pendingQuestion && currentThreadId) {
			if (!selectedQuestionOptionId && !prompt.trim()) return;
			state.answer(currentThreadId, selectedQuestionOptionId, prompt);
		} else if (prompt.trim() && selection.model && selection.effort) {
			setCurrentThreadId(
				state.submitPrompt(
					currentThreadId,
					project.repositoryKey,
					prompt.trim(),
					selection.model,
					selection.effort
				)
			);
		} else {
			return;
		}

		setPrompt('');
		setSelectedQuestionOptionId(null);
	}

	return (
		<div className="relative h-dvh overflow-hidden">
			<div
				className={cn('app-workspace-shell inbox-layout', !sidebarOpen && 'sidebar-hidden')}
				inert={fullscreenArtifact ? true : undefined}
			>
				{sidebarOpen && (
					<button
						className="inbox-sidebar-backdrop fixed inset-0 z-[140] bg-black/40 md:hidden"
						type="button"
						aria-label="Close sidebar"
						onClick={() => setSidebarOpen(false)}
					/>
				)}
				<div className="inbox-sidebar-host" inert={!sidebarOpen}>
					<DemoSidebar
						state={state}
						signedInUserId={state.userId}
						localApi={null}
						sections={state.sections(search, selectedProjects)}
						search={search}
						onSearchChange={setSearch}
						projects={projectList}
						models={modelCatalog?.models ?? []}
						selectedProjects={selectedProjects}
						currentThreadId={currentThreadId}
						settledOpen={settledOpen}
						onSettledOpenChange={setSettledOpen}
						mutationsEnabled={true}
						theme={theme}
						onThemeChange={changeTheme}
						onClose={() => setSidebarOpen(false)}
						onFilter={setSelectedProjects}
						onSelect={(thread) => selectThread(thread._id)}
						onNew={() => {
							setNewThreadProject(project.repositoryKey);
							selectThread(null);
						}}
						onAddProject={() => {}}
						onSettings={() => {}}
						onChange={async (thread, inboxState) => {
							state.setInboxState(thread._id, inboxState);

							if (inboxState === 'settled' && currentThreadId === thread._id) selectThread(null);
						}}
						onRename={async (thread, title) => state.rename(thread._id, title)}
						onRegenerateTitle={async () => {}}
						onMove={async () => {}}
					/>
				</div>

				{!sidebarOpen && (
					<div className="inbox-floating-controls">
						<button
							className="inbox-icon touch-target"
							type="button"
							aria-label="Open sidebar"
							title="Open sidebar"
							onClick={() => setSidebarOpen(true)}
						>
							<img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="size-6" />
						</button>
					</div>
				)}

				<main
					className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
					inert={sidebarOpen && narrow}
				>
					<MarkdownFileLinksContext value={markdownFileLinks}>
						<SidePanel
							key={artifactPanel.layoutKey}
							panel={artifactPanel}
							workspacePath={project.workspacePath}
							artifacts={artifacts}
							artifactContents={artifactContents}
							browserApi={null}
							filesApi={filesApi}
							onOpenFullscreen={(key) => {
								setArtifactFullscreenRequest(requestArtifactFullscreen());
								artifactPanel.setFullscreenKey(key);
							}}
							transcript={
								<>
									{currentThreadId && (
										<ThreadTranscript
											key={currentThreadId}
											store={transcript}
											activeRunId={
												run?.status === 'running' || run?.status === 'paying' ? run.runId : null
											}
											project={project}
											artifacts={artifacts}
											onOpenArtifact={(artifactId) => artifactPanel.openArtifact(artifactId)}
											emptyStateMessage=""
											renderRunFooter={(runId) => (
												<RunUsageFooter
													runId={convexId<'runs'>().parse(runId)}
													modelCatalog={modelCatalog}
												/>
											)}
										/>
									)}

									<div className={!currentThreadId ? 'create-thread-screen' : 'shrink-0'}>
										{!currentThreadId && (
											<CreateThreadHeading
												projects={projectList}
												workspacePath={project.workspacePath}
												onProject={(workspacePath) =>
													setNewThreadProject(
														projectList.find((item) => item.workspacePath === workspacePath)
															?.repositoryKey ?? newThreadProject
													)
												}
												onAddProject={() => {}}
											/>
										)}

										{catalog.status === 'loading' ? (
											<div className="text-muted-foreground mb-3 text-sm">Loading models…</div>
										) : null}

										<div className={!currentThreadId ? 'create-thread-composer' : ''}>
											<PromptComposer
												notices={
													<>
														<PurchaseApprovals
															purchases={
																currentThreadId ? state.pendingPurchases(currentThreadId) : []
															}
														/>
														<ConversationNotices
															key={currentThreadId}
															error={null}
															runError={null}
															reconnecting={false}
															syncing={false}
															catalogError={catalog.status === 'failed'}
															catalogLoading={catalog.status === 'loading'}
															onRetryCatalog={() => void state.loadCatalog()}
														/>
													</>
												}
												prompt={prompt}
												onPromptChange={setPrompt}
												attachments={[]}
												onAttachFiles={() => {}}
												onRemoveAttachment={() => {}}
												modelCatalog={modelCatalog}
												selectedModel={selection.model}
												onSelectedModelChange={(model) =>
													setSelection((current) => ({ ...current, model }))
												}
												selectedReasoningEffort={selection.effort}
												onSelectedReasoningEffortChange={(effort) =>
													setSelection((current) => ({ ...current, effort }))
												}
												pendingQuestion={pendingQuestion}
												usageThreadId={currentThreadId}
												selectedQuestionOptionId={selectedQuestionOptionId}
												onSelectedQuestionOptionIdChange={setSelectedQuestionOptionId}
												canSend={!working || pendingQuestion !== null}
												submitting={null}
												isRunning={working}
												isWorking={working}
												onSubmit={submit}
												onCancel={() => currentThreadId && state.cancel(currentThreadId)}
												onSkipQuestion={() =>
													currentThreadId && state.skipQuestion(currentThreadId)
												}
											/>
										</div>
									</div>
								</>
							}
						/>
					</MarkdownFileLinksContext>
				</main>
			</div>

			<MarkdownFileLinksContext value={markdownFileLinks}>
				{fullscreenArtifact && artifactFullscreenRequest && (
					<ArtifactScreenFullscreen
						workspacePath={project.workspacePath}
						artifact={fullscreenArtifact}
						content={artifactContents.get(fullscreenArtifact.key) ?? { status: 'loading' }}
						fullscreenRequest={artifactFullscreenRequest}
						onClose={() => artifactPanel.setFullscreenKey(null)}
					/>
				)}
			</MarkdownFileLinksContext>
		</div>
	);
}
