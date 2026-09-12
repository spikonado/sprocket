import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { isJsonBoolean, isJsonObject, isJsonString } from '@convex/lib/json';
import { omit } from 'convex-helpers';

type State = Doc<'threadTranscriptDisplayStates'>;
type Row = Doc<'threadTranscriptDisplayRows'>;
type Item = Doc<'threadTranscriptDisplayItems'>;
type Part = Doc<'threadTranscriptParts'>;
type ItemData = Omit<Item, '_id' | '_creationTime'>;
const ITEM_ORDER_STRIDE = 16_384;

export async function displayState(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<State> {
	const existing = await ctx.db
		.query('threadTranscriptDisplayStates')
		.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
		.unique();
	if (existing) return existing;
	const id = await ctx.db.insert('threadTranscriptDisplayStates', {
		threadId,
		throughNumber: 0,
		throughIndex: 0,
		nextSequence: 0
	});
	const state = await ctx.db.get('threadTranscriptDisplayStates', id);
	if (!state) throw new Error('Could not create transcript display index.');
	return state;
}

export async function scheduleDisplayBackfill(ctx: MutationCtx, state: State) {
	const scheduled = state.scheduledId
		? await ctx.db.system.get('_scheduled_functions', state.scheduledId)
		: null;
	if (scheduled?.state.kind === 'pending' || scheduled?.state.kind === 'inProgress') return;
	const scheduledId = await ctx.scheduler.runAfter(0, internal.transcriptDisplay.backfill, {
		threadId: state.threadId
	});
	await ctx.db.patch('threadTranscriptDisplayStates', state._id, { scheduledId });
}

class DisplayWriter {
	private changedRows = new Set<Id<'threadTranscriptDisplayRows'>>();
	constructor(
		private ctx: MutationCtx,
		private state: State,
		private part: Part
	) {}

	private async tail() {
		return this.state.tailRowId
			? await this.ctx.db.get('threadTranscriptDisplayRows', this.state.tailRowId)
			: null;
	}

	private async addRow(
		kind: Row['kind'],
		extra: Partial<
			Pick<Row, 'text' | 'attachments' | 'startedAt' | 'mandateId' | 'approvalUrl'>
		> = {},
		setTail = true
	): Promise<Row> {
		const id = await this.ctx.db.insert('threadTranscriptDisplayRows', {
			threadId: this.part.threadId,
			runId: this.part.runId,
			sequence: this.state.nextSequence++,
			kind,
			itemCount: 0,
			canonicalItems: 0,
			pendingTools: 0,
			missingStarts: 0,
			missingEnds: 0,
			closed: kind !== 'work',
			revision: this.part.number,
			...extra
		});
		if (setTail) this.state.tailRowId = id;
		const row = await this.ctx.db.get('threadTranscriptDisplayRows', id);
		if (!row) throw new Error('Could not create transcript display row.');
		return row;
	}

	private async closeTail(endedAt?: number) {
		const tail = await this.tail();
		if (tail?.kind !== 'work') return;
		await this.ctx.db.patch('threadTranscriptDisplayRows', tail._id, {
			closed: true,
			endedAt,
			revision: this.part.number
		});
		this.changedRows.add(tail._id);
	}

	private async workRow(): Promise<Row> {
		const tail = await this.tail();
		if (tail?.kind === 'work' && tail.runId === this.part.runId && !tail.closed) return tail;
		await this.closeTail();
		return await this.addRow('work');
	}

	private async findItem(key: string) {
		return await this.ctx.db
			.query('threadTranscriptDisplayItems')
			.withIndex('by_threadId_and_key', (q) => q.eq('threadId', this.part.threadId).eq('key', key))
			.unique();
	}

	private async adjust(item: ItemData, delta: number) {
		const row = await this.ctx.db.get('threadTranscriptDisplayRows', item.rowId);
		if (!row) throw new Error('Transcript display item has no section.');
		const canonicalItems = row.canonicalItems + (item.sourceIndex === undefined ? 0 : delta);
		await this.ctx.db.patch('threadTranscriptDisplayRows', row._id, {
			itemCount: row.itemCount + delta,
			canonicalItems,
			provisional: canonicalItems === 0,
			pendingTools:
				row.pendingTools +
				(item.kind === 'tool' && (item.completedAt === undefined || item.sessionRunning)
					? delta
					: 0),
			missingStarts: row.missingStarts + (item.startedAt === undefined ? delta : 0),
			missingEnds: row.missingEnds + (item.completedAt === undefined ? delta : 0),
			revision: this.part.number
		});
		this.changedRows.add(row._id);
	}

	private async putItem(data: ItemData, previous: Item | null) {
		if (previous) {
			await this.adjust(previous, -1);
			await this.ctx.db.replace('threadTranscriptDisplayItems', previous._id, data);
		} else {
			await this.ctx.db.insert('threadTranscriptDisplayItems', data);
		}
		await this.adjust(data, 1);
	}

	private async tool(callId: string, name: string, sourceIndex?: number) {
		if (
			[
				'add_artifact',
				'list_artifacts',
				'edit_artifact',
				'create_artifact',
				'update_artifact'
			].includes(name)
		)
			return;
		const key = `${this.part.runId}:tool:${callId}`;
		const previous = await this.findItem(key);
		const item = sourceIndex === undefined ? undefined : this.part.completion?.items[sourceIndex];
		const isCall = item?.type === 'tool-call';
		const isResult = this.part.tool !== undefined && this.part.tool.status !== 'started';
		const output = this.part.tool?.output;
		const reportedRunning =
			isResult && isJsonObject(output) && isJsonBoolean(output.running)
				? output.running
				: previous?.reportedRunning;
		const resultRevision = isResult ? this.part.number : previous?.resultRevision;
		const sessionId =
			isJsonObject(output) && isJsonString(output.sessionId)
				? output.sessionId
				: isCall && isJsonObject(item.input) && isJsonString(item.input.sessionId)
					? item.input.sessionId
					: previous?.sessionId;
		const rowId = isCall || !previous ? (await this.workRow())._id : previous.rowId;
		const data: ItemData = {
			threadId: this.part.threadId,
			key,
			rowId,
			kind: 'tool',
			callId,
			name,
			order:
				isCall || !previous
					? this.part.number * ITEM_ORDER_STRIDE + (sourceIndex ?? 0)
					: previous.order,
			sourcePartId: isCall || !previous ? this.part._id : previous.sourcePartId,
			sourceIndex: isCall ? sourceIndex : previous?.sourceIndex,
			resultPartId: isResult ? this.part._id : previous?.resultPartId,
			resultRevision,
			reportedRunning,
			sessionId,
			sessionRunning: previous?.sessionRunning,
			mandateId: previous?.mandateId,
			approvalUrl: previous?.approvalUrl,
			approvalRowId: previous?.approvalRowId,
			startedAt:
				(isCall ? item.startedAt : undefined) ??
				previous?.startedAt ??
				(this.part.tool?.status === 'started' ? this.part._creationTime : undefined),
			completedAt: isResult ? this.part._creationTime : previous?.completedAt
		};
		if (
			sessionId &&
			resultRevision !== undefined &&
			reportedRunning !== undefined &&
			(name === 'exec_command' || name === 'write_stdin')
		) {
			const session = await this.ctx.db
				.query('threadTranscriptDisplaySessions')
				.withIndex('by_threadId_and_runId_and_sessionId', (q) =>
					q
						.eq('threadId', this.part.threadId)
						.eq('runId', this.part.runId)
						.eq('sessionId', sessionId)
				)
				.unique();
			const latest =
				session && session.revision > resultRevision
					? session
					: {
							running: reportedRunning,
							revision: resultRevision,
							completedAt: data.completedAt ?? this.part._creationTime
						};
			const execKey = name === 'exec_command' ? key : session?.execKey;
			const sessionData = {
				threadId: this.part.threadId,
				runId: this.part.runId,
				sessionId,
				execKey,
				running: latest.running,
				revision: latest.revision,
				completedAt: latest.completedAt
			};
			if (session)
				await this.ctx.db.replace('threadTranscriptDisplaySessions', session._id, sessionData);
			else await this.ctx.db.insert('threadTranscriptDisplaySessions', sessionData);
			if (name === 'exec_command') {
				data.sessionRunning = latest.running;
				if (!latest.running) data.completedAt = latest.completedAt;
			} else if (execKey) {
				const exec = await this.findItem(execKey);
				if (exec) {
					await this.putItem(
						{
							...omit(exec, ['_id', '_creationTime']),
							sessionRunning: latest.running,
							completedAt: latest.running ? exec.completedAt : latest.completedAt
						},
						exec
					);
				}
			}
		}
		if (
			name === 'mandate_setup' &&
			isJsonObject(output) &&
			isJsonString(output.mandateId) &&
			isJsonString(output.approvalUrl)
		) {
			data.mandateId = output.mandateId;
			data.approvalUrl = output.approvalUrl;
		}
		if (
			data.sourceIndex !== undefined &&
			data.mandateId &&
			data.approvalUrl &&
			!data.approvalRowId
		) {
			const approval = await this.addRow(
				'approval',
				{ mandateId: data.mandateId, approvalUrl: data.approvalUrl },
				false
			);
			data.approvalRowId = approval._id;
		}
		await this.putItem(data, previous);
	}

	async write(itemLimit: number) {
		const part = this.part;
		const endIndex = Math.min(
			this.state.throughIndex + itemLimit,
			part.completion?.items.length ?? 0
		);
		const done = endIndex === (part.completion?.items.length ?? 0);
		if (part.prompt) {
			await this.closeTail();
			await this.addRow('prompt', {
				text: part.prompt.text,
				attachments: part.prompt.imageUploads.map(({ storageId, name, mediaType, size }) => ({
					storageId,
					name,
					mediaType,
					size
				}))
			});
		}
		if (part.tool) await this.tool(part.tool.callId, part.tool.name);
		if (part.completion) {
			for (let index = this.state.throughIndex; index < endIndex; index += 1) {
				const item = part.completion.items[index];
				if (item.type === 'text') {
					if (!item.text.trim()) continue;
					await this.closeTail(item.startedAt ?? undefined);
					await this.addRow('text', { text: item.text, startedAt: item.startedAt ?? undefined });
				} else if (item.type === 'reasoning') {
					if (!item.text.trim()) continue;
					const key = `${part.runId}:reasoning:${part.number}:${index}`;
					await this.putItem(
						{
							threadId: part.threadId,
							key,
							rowId: (await this.workRow())._id,
							order: part.number * ITEM_ORDER_STRIDE + index,
							kind: 'reasoning',
							sourcePartId: part._id,
							sourceIndex: index,
							startedAt: item.startedAt ?? undefined,
							completedAt: item.completedAt ?? undefined
						},
						await this.findItem(key)
					);
				} else {
					await this.tool(item.callId, item.name, index);
				}
			}
			if (done && part.completion.streamId) {
				await this.ctx.db.insert('threadTranscriptDisplayStreams', {
					threadId: part.threadId,
					runId: part.runId,
					streamId: part.completion.streamId
				});
			}
		}
		for (const id of this.changedRows) {
			const row = await this.ctx.db.get('threadTranscriptDisplayRows', id);
			if (!row) continue;
			const previousChange = await this.ctx.db
				.query('threadTranscriptDisplayChanges')
				.withIndex('by_threadId_and_rowId', (q) => q.eq('threadId', part.threadId).eq('rowId', id))
				.unique();
			const change = {
				threadId: part.threadId,
				rowId: id,
				sequence: row.sequence,
				revision: part.number,
				deleted: !row.itemCount
			};
			if (previousChange)
				await this.ctx.db.replace('threadTranscriptDisplayChanges', previousChange._id, change);
			else await this.ctx.db.insert('threadTranscriptDisplayChanges', change);
			if (!row.itemCount) {
				await this.ctx.db.delete('threadTranscriptDisplayRows', id);
				if (this.state.tailRowId === id) this.state.tailRowId = undefined;
				continue;
			}
			const first = row.missingStarts
				? null
				: await this.ctx.db
						.query('threadTranscriptDisplayItems')
						.withIndex('by_rowId_and_startedAt', (q) => q.eq('rowId', id))
						.first();
			const last = await this.ctx.db
				.query('threadTranscriptDisplayItems')
				.withIndex('by_rowId_and_completedAt', (q) => q.eq('rowId', id))
				.order('desc')
				.first();
			await this.ctx.db.patch('threadTranscriptDisplayRows', id, {
				startedAt: first?.startedAt,
				completedAt:
					row.missingEnds && row.endedAt === undefined
						? undefined
						: Math.max(row.endedAt ?? 0, last?.completedAt ?? 0)
			});
		}
		await this.ctx.db.patch('threadTranscriptDisplayStates', this.state._id, {
			throughNumber: done ? part.number + 1 : part.number,
			throughIndex: done ? 0 : endIndex,
			nextSequence: this.state.nextSequence,
			tailRowId: this.state.tailRowId
		});
	}
}

export async function indexTranscriptPart(ctx: MutationCtx, part: Part, itemLimit: number) {
	const state = await displayState(ctx, part.threadId);
	if (state.throughNumber > part.number) return;
	if (state.throughNumber < part.number) {
		await scheduleDisplayBackfill(ctx, state);
		return;
	}
	await new DisplayWriter(ctx, state, part).write(itemLimit);
}
