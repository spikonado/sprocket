import { vi } from 'vitest';
import type { LocalServerMessage } from './socket';

export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	sent: unknown[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}

	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	receive(message: LocalServerMessage) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

export function stubWebSocket(): FakeWebSocket[] {
	FakeWebSocket.instances = [];
	vi.stubGlobal('WebSocket', FakeWebSocket);

	return FakeWebSocket.instances;
}
