export const KICAD_FILE = /\.kicad_(?:pro|sch|pcb)$/;

const SHEET_FILE = /\(property\s+"Sheet ?file"\s+"([^"]+)"/g;

function directoryOf(path: string) {
	return path.slice(0, path.lastIndexOf('/') + 1);
}

function normalize(path: string) {
	const parts: string[] = [];

	for (const part of path.split('/')) {
		if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop();
		else if (part === '..') parts.push(part);
		else if (part && part !== '.') parts.push(part);
	}

	return parts.join('/');
}

/**
 * Reads what KiCanvas needs to show `path`: a project brings its root schematic and board, and
 * schematics bring their sheets. Names are relative to `path`'s folder, as KiCad links sheets.
 */
export async function readKicadSources(
	path: string,
	read: (path: string) => Promise<string>
): Promise<{ name: string; content: string }[]> {
	const directory = directoryOf(path);
	const opened = path.slice(directory.length);
	const stem = opened.replace(KICAD_FILE, '');
	const sources = new Map<string, string>();

	const load = async (names: string[], required: boolean) => {
		const fresh = [...new Set(names)].filter((name) => !sources.has(name));
		const results = await Promise.allSettled(fresh.map((name) => read(directory + name)));

		return fresh.filter((name, index) => {
			const result = results[index];

			if (result.status === 'fulfilled') {
				sources.set(name, result.value);

				return true;
			}

			if (required) throw result.reason;

			return false;
		});
	};

	let loaded = await load([opened], true);

	if (opened.endsWith('.kicad_pro')) {
		loaded = await load([`${stem}.kicad_sch`, `${stem}.kicad_pcb`], false);
	}

	while (loaded.length > 0) {
		const sheets = loaded
			.filter((name) => name.endsWith('.kicad_sch'))
			.flatMap((name) =>
				Array.from(sources.get(name)!.matchAll(SHEET_FILE), ([, sheet]) =>
					normalize(directoryOf(name) + sheet)
				)
			);

		loaded = await load(sheets, false);
	}

	return Array.from(sources, ([name, content]) => ({ name, content }));
}
