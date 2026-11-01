import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { repairMermaidSource } from '$lib/chat/mermaid-repair';
import MermaidDiagram from './mermaid-diagram';

describe('Mermaid diagrams', () => {
	it.each([
		[
			'command flags in flowchart edge labels',
			'flowchart-v2',
			`flowchart LR
  A[Agent] -- writes --> S["mech/part.py<br/>(params at top, mm, Z up)"]
  A -- shell: QT_QPA_PLATFORM=offscreen FreeCAD part.py --> FC[FreeCAD GUI, offscreen]
  FC --> F["mech/part.FCStd + part.step<br/>(colours via ImportGui.export)"]
  A -- MCP viewer_show(path, kind=mech) --> V[Mech tab 3D viewer]
  F --> G["step2glb<br/>(occt-import-js, FreeCAD fallback)"] --> V
  A -- optional: backplane --render --> R["mech/renders/part.{iso,front,top,right}.png"]`
		],
		[
			'semicolons in sequence diagram text',
			'sequence',
			`sequenceDiagram
  T->>C: checkoutCreate (attemptId; checks https origin, recognizer, amount)
  loop until approved; or expired
    Note over C: polls #quot;status#quot;; waits
  end`
		]
	])('accepts %s', async (_, diagramType, source) => {
		const { default: mermaid } = await import('mermaid');

		await expect(mermaid.parse(source)).rejects.toThrow();
		await expect(mermaid.parse(repairMermaidSource(source, diagramType))).resolves.toMatchObject({
			diagramType
		});
	});

	it('retries a flowchart with an unquoted command flag and displays the diagram', async () => {
		const { default: mermaid } = await import('mermaid');

		const renderDiagram = vi.spyOn(mermaid, 'render').mockImplementation(async (_id, source) => {
			await mermaid.parse(source);

			return {
				diagramType: 'flowchart-v2',
				svg: '<svg><text>optional: backplane --render</text></svg>'
			};
		});

		try {
			const { container, queryByText } = render(
				<MermaidDiagram
					source={'flowchart LR\n A -- optional: backplane --render --> B'}
					codeHtml="<pre><code>source</code></pre>"
				/>
			);

			await waitFor(() =>
				expect(container.querySelector('svg')?.textContent).toContain('--render')
			);
			expect(container.querySelector('code')).toBeNull();
			expect(queryByText('Could not render diagram.')).toBeNull();
			expect(renderDiagram).toHaveBeenCalledTimes(2);
		} finally {
			renderDiagram.mockRestore();
		}
	});

	it('shows the source and an error when a diagram cannot render', async () => {
		const { getByText, container } = render(
			<MermaidDiagram source="not a diagram" codeHtml="<pre><code>not a diagram</code></pre>" />
		);

		await waitFor(() => expect(getByText('Could not render diagram.')).toBeTruthy());
		expect(container.querySelector('code')?.textContent).toBe('not a diagram');
	});
});
