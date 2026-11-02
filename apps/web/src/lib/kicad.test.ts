import { describe, expect, it } from 'vitest';
import { readKicadSources } from './kicad';

const files = new Map([
	['boards/amp/amp.kicad_pro', '{}'],
	[
		'boards/amp/amp.kicad_sch',
		'(kicad_sch (sheet (property "Sheetname" "L") (property "Sheetfile" "sheets/ch.kicad_sch"))' +
			' (sheet (property "Sheetfile" "sheets/ch.kicad_sch"))' +
			' (sheet (property "Sheetfile" "../shared.kicad_sch")))'
	],
	[
		'boards/amp/sheets/ch.kicad_sch',
		'(kicad_sch (sheet (property "Sheetfile" "../power.kicad_sch")))'
	],
	['boards/amp/power.kicad_sch', '(kicad_sch)'],
	['boards/amp/../shared.kicad_sch', '(kicad_sch)']
]);

async function read(path: string) {
	const content = files.get(path);

	if (content === undefined) throw new Error(`${path} does not exist`);

	return content;
}

describe('readKicadSources', () => {
	it('loads a project with its root schematic and every sheet once', async () => {
		const sources = await readKicadSources('boards/amp/amp.kicad_pro', read);

		expect(sources.map((source) => source.name)).toEqual([
			'amp.kicad_pro',
			'amp.kicad_sch',
			'sheets/ch.kicad_sch',
			'../shared.kicad_sch',
			'power.kicad_sch'
		]);
	});

	it('fails when the opened file is missing', async () => {
		await expect(readKicadSources('boards/amp/gone.kicad_pcb', read)).rejects.toThrow(
			'does not exist'
		);
	});
});
