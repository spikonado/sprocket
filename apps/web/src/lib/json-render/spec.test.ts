import { describe, expect, it } from 'vitest';
import { parseJsonRenderSpec } from './spec';

const card = '{"type":"Card","props":{"title":"CI"},"children":[]}';

describe('parseJsonRenderSpec', () => {
	it('reads a whole spec document', () => {
		const spec = parseJsonRenderSpec(`{"root":"ci","elements":{"ci":${card}}}`);

		expect(spec?.root).toBe('ci');
		expect(spec?.elements.ci?.type).toBe('Card');
	});

	it('reads JSONL patches', () => {
		const spec = parseJsonRenderSpec(
			[
				'{"op":"add","path":"/root","value":"ci"}',
				`{"op":"add","path":"/elements/ci","value":${card}}`
			].join('\n')
		);

		expect(spec?.elements.ci?.type).toBe('Card');
	});

	it('returns null when a stream patch walks through null', () => {
		expect(
			parseJsonRenderSpec(
				[
					'{"op":"add","path":"/root","value":"ci"}',
					'{"op":"add","path":"/elements/ci","value":null}',
					'{"op":"add","path":"/elements/ci/props","value":{"title":"CI"}}'
				].join('\n')
			)
		).toBeNull();
	});

	it('keeps a spec after a later patch walks through null children', () => {
		const spec = parseJsonRenderSpec(
			[
				'{"op":"add","path":"/root","value":"ci"}',
				`{"op":"add","path":"/elements/ci","value":{"type":"Card","props":{"title":"CI"},"children":null}}`,
				'{"op":"add","path":"/elements/ci/children/0","value":"jobs"}'
			].join('\n')
		);

		expect(spec?.elements.ci?.type).toBe('Card');
	});
});
