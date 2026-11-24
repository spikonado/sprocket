import { demoProject } from '../demo-project';
import { prompt, recordRun, say, think, tool, work } from '../rows';
import type { DemoThread } from '../types';

const flakyTest: DemoThread = {
	id: 'tidepool-flaky',
	title: 'Fix the flaky tide table test',
	model: 'gpt-6.1-terra',
	effort: 'medium',
	minutesAgo: 5,
	runs: [
		recordRun('run-tidepool-flaky-1', [
			prompt('CI keeps failing on tides.test.ts, but only sometimes. Find out why and fix it.'),
			work(
				tool(
					'exec_cmd',
					'gh run list --workflow ci.yml --limit 40 --json conclusion,createdAt,databaseId'
				),
				think(
					'Finding the pattern',
					'7 of the last 40 runs failed, and all 7 started between 00:00 and 08:00 UTC. In Los Angeles that is 16:00 to midnight, when the UTC date is already tomorrow.'
				),
				tool('exec_cmd', 'gh run view 19876 --log-failed'),
				tool('exec_cmd', 'cat src/lib/tides.ts src/lib/tides.test.ts'),
				think(
					'Reading the grouping',
					'`tidesByDay` keys each prediction with `toISOString().slice(0, 10)`, which is the UTC date. The test builds an evening tide from `new Date()`, so after 16:00 Pacific it lands on the next day. Visitors see the same bug: evening tides show up under tomorrow.'
				),
				tool('apply_patch', 'src/lib/tides.ts\nsrc/lib/tides.test.ts'),
				tool('exec_cmd', 'bun test src/lib/tides.test.ts'),
				tool('exec_cmd', 'TZ=Pacific/Kiritimati bun test && TZ=Pacific/Pago_Pago bun test'),
				tool(
					'exec_cmd',
					'git switch -c fix/tide-day-timezone && git commit -am "fix: group tides by the station\'s day"'
				),
				tool('exec_cmd', 'git push -u origin fix/tide-day-timezone && gh pr create --fill'),
				tool('link_prs', 'github.com/maker/tidepool#42')
			),
			say(`The test was right to fail. \`tidesByDay\` grouped tides by their UTC date, so from 16:00 Pacific on, evening tides moved to the next day, on the site too. CI only failed when it ran in that window.

\`\`\`diff
-	const day = (time: Date) => time.toISOString().slice(0, 10);
+	const day = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
 	for (const prediction of predictions) {
-		const key = day(prediction.time);
+		const key = day.format(prediction.time);
\`\`\`

The test now uses a fixed 18:42 PST tide instead of \`new Date()\`, so it fails every time the bug is back. It passes with the clock set to UTC+14 and UTC−11.

I opened [maker/tidepool#42](https://github.com/maker/tidepool/pull/42).`)
		])
	]
};

const cache: DemoThread = {
	id: 'tidepool-cache',
	title: 'Explain the forecast cache',
	model: 'haiku-5.5',
	effort: 'low',
	settled: true,
	minutesAgo: 60 * 5,
	runs: [
		recordRun('run-tidepool-cache-1', [
			prompt('How does the forecast cache work? Draw it.'),
			work(
				tool('exec_cmd', 'cat src/lib/noaa.ts'),
				tool('exec_cmd', 'grep -rn "predictions(" src')
			),
			say(`\`predictions()\` in \`src/lib/noaa.ts\` keeps one entry per station in memory for 6 hours.

\`\`\`mermaid
flowchart LR
  A["Page loads a station"] --> B{"Fresh in cache?"}
  B -->|"yes"| C["Return the cached promise"]
  B -->|"no"| D["Fetch 7 days of highs and lows from NOAA"]
  D --> E["Cache the promise"]
  E --> C
  D -->|"request fails"| F["Drop the entry"]
\`\`\`

- It caches the promise, so pages that load at the same moment share one NOAA request.
- A failed request drops its entry, so the next page load tries again.
- The cache lives in the server process, so each deploy starts empty.`)
		])
	]
};

export const tidepool = demoProject({
	name: 'tidepool',
	files: {
		'README.md': `# tidepool

Tide tables for any NOAA station, grouped by the station's local day.

\`\`\`sh
bun install
bun run dev
bun test
\`\`\`
`,
		'package.json': `{
	"name": "tidepool",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "vite dev",
		"build": "vite build",
		"test": "bun test"
	}
}
`,
		'src/lib/tides.ts': `export type Prediction = { time: Date; heightM: number; kind: 'high' | 'low' };

/** Groups predictions by the station's calendar day, not the viewer's or UTC's. */
export function tidesByDay(predictions: Prediction[], timeZone: string) {
	const day = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
	const days = new Map<string, Prediction[]>();

	for (const prediction of predictions) {
		const key = day.format(prediction.time);
		days.set(key, [...(days.get(key) ?? []), prediction]);
	}

	return days;
}
`,
		'src/lib/tides.test.ts': `import { expect, test } from 'bun:test';
import { tidesByDay } from './tides';

test('an evening high tide stays on its local day', () => {
	const tide = { time: new Date('2026-11-23T18:42:00-08:00'), heightM: 2.1, kind: 'high' as const };

	expect([...tidesByDay([tide], 'America/Los_Angeles').keys()]).toEqual(['2026-11-23']);
});
`,
		'src/lib/noaa.ts': `import type { Prediction } from './tides';

const TTL_MS = 6 * 60 * 60 * 1000;
const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const cache = new Map<string, { at: number; predictions: Promise<Prediction[]> }>();

type Response = { predictions: { t: string; v: string; type: 'H' | 'L' }[] };

async function fetchPredictions(station: string): Promise<Prediction[]> {
	const query = new URLSearchParams({
		product: 'predictions',
		interval: 'hilo',
		datum: 'MLLW',
		station,
		date: 'today',
		range: '168',
		time_zone: 'gmt',
		units: 'metric',
		format: 'json'
	});
	const response = await fetch(\`\${API}?\${query}\`);

	if (!response.ok) throw new Error(\`NOAA returned \${response.status}\`);

	const body: Response = await response.json();

	return body.predictions.map(({ t, v, type }) => ({
		time: new Date(\`\${t.replace(' ', 'T')}Z\`),
		heightM: Number(v),
		kind: type === 'H' ? 'high' : 'low'
	}));
}

export function predictions(station: string, now = Date.now()) {
	const cached = cache.get(station);

	if (cached && now - cached.at < TTL_MS) return cached.predictions;

	const pending = fetchPredictions(station);
	cache.set(station, { at: now, predictions: pending });
	pending.catch(() => cache.delete(station));

	return pending;
}
`
	},
	threads: [flakyTest, cache]
});
