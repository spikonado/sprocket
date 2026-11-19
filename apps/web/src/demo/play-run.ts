import type { TranscriptRow } from '$lib/types/sprocket';
import type { TranscriptFixture } from './fixtures/types';
import type { DemoTranscripts } from './transcript-api';

const WORDS_PER_CHUNK = 3;

function wait(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const timer = setTimeout(resolve, ms);

		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}

function startedItem(row: TranscriptRow): TranscriptRow {
	if (row.kind === 'tool') return { ...row, status: 'running' };

	if (row.kind === 'reasoning') return { ...row, running: true };

	return row;
}

function cancelledItem(row: TranscriptRow): TranscriptRow {
	if (row.kind === 'tool') return { ...row, status: 'cancelled' };

	return row;
}

/**
 * Streams a recorded run into the transcript the way the local server would while the agent works.
 * Resolves with the rows that played, which is fewer than the recording when the signal aborts.
 */
export async function playRun(
	transcripts: DemoTranscripts,
	threadId: string,
	run: TranscriptFixture,
	signal: AbortSignal
): Promise<TranscriptFixture> {
	const played: TranscriptFixture = { rows: [], work: {}, items: {} };

	try {
		for (const row of run.rows) {
			if (row.kind === 'text') {
				let text = '';
				transcripts.putRow(threadId, { ...row, text, running: true });

				try {
					const words = row.text.match(/\S+\s*/g) ?? [];

					for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
						await wait(30, signal);
						const chunk = words.slice(index, index + WORDS_PER_CHUNK).join('');
						text += chunk;
						transcripts.appendText(threadId, row.id, chunk);
					}
				} catch (error) {
					played.rows.push({ ...row, text });
					transcripts.putRow(threadId, { ...row, text, running: false });
					throw error;
				}

				played.rows.push(row);
			} else if (row.kind === 'work') {
				const toolCounts: Record<string, number> = {};
				const items: TranscriptRow[] = (played.work[row.id] = []);
				played.rows.push({ ...row, toolCounts });
				transcripts.putRow(threadId, { ...row, toolCounts: {}, running: true });

				for (const item of run.work[row.id] ?? []) {
					transcripts.putWorkItem(threadId, row.id, startedItem(item));

					try {
						await wait(450 + Math.random() * 250, signal);
					} catch (error) {
						transcripts.putWorkItem(threadId, row.id, cancelledItem(item));
						transcripts.putRow(threadId, { ...row, toolCounts, running: false });
						throw error;
					}

					const detail = run.items[item.id];

					if (detail) transcripts.putDetail(threadId, detail);
					transcripts.putWorkItem(threadId, row.id, item);
					items.push(item);

					if (item.kind === 'tool') {
						toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
						transcripts.putRow(threadId, { ...row, toolCounts: { ...toolCounts }, running: true });
					}
				}
			} else {
				played.rows.push(row);
			}

			transcripts.putRow(threadId, row);
			await wait(row.kind === 'prompt' ? 500 : 150, signal);
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	}

	return played;
}
