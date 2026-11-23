import { prompt, say, think, work, type Step } from './rows';

export const DOWNLOAD_URL = 'https://usesprocket.dev/#download';

export function previewReply(text: string): Step[] {
	return [
		prompt(text),
		work(
			think(
				'Checking what this preview can do',
				'This window replays recorded work. It has no machine attached, so I cannot read files, run tools or order parts for this request.'
			)
		),
		say(
			`This is a preview of recorded Sprocket work, so I can't act on that here. Nothing you type leaves this page.\n\nIn the real app I'd pick this up in your project: read the code and schematics, run commands and KiCad checks, look up parts, and ask when a decision is yours to make.\n\n[Download Sprocket](${DOWNLOAD_URL}) to run it on your own projects.`
		)
	];
}
