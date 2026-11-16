import { createContext, use } from 'react';
import { useTranscriptRow, type TranscriptStore } from './transcript-store';

export const TranscriptActiveRunContext = createContext<string | null | undefined>(undefined);

export function useTranscriptRunRow(store: TranscriptStore, rowId: string, detail = false) {
	const row = useTranscriptRow(store, rowId, detail);
	const activeRunId = use(TranscriptActiveRunContext);

	if (!row || activeRunId === undefined || row.runId === activeRunId) return row;

	if (row.kind === 'tool' && row.status === 'running') {
		return {
			...row,
			status: 'interrupted' as const,
			error: 'The agent stopped before this tool call finished.'
		};
	}

	if (row.kind === 'work' || row.kind === 'reasoning' || row.kind === 'text') {
		return { ...row, running: false };
	}

	return row;
}
