import { useEffect, useRef } from 'react';
import type { SkillSummary } from '$lib/types/sprocket';

export default function ComposerSkillMenu({
	prefix,
	loadState,
	skills,
	highlightedIndex,
	onRetry,
	onHighlight,
	onSelect
}: {
	prefix: '$' | '/';
	loadState: 'idle' | 'loading' | 'ready' | 'error';
	skills: SkillSummary[];
	highlightedIndex: number;
	onRetry: () => void;
	onHighlight: (index: number) => void;
	onSelect: (skill: SkillSummary) => void;
}) {
	const label = prefix === '/' ? 'commands' : 'skills';
	const optionElements = useRef<Array<HTMLButtonElement | null>>([]);

	useEffect(() => {
		if (skills.length > 0)
			optionElements.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
	}, [skills, highlightedIndex]);

	return (
		<div
			className="border-border bg-popover absolute inset-x-0 bottom-full z-30 mb-2 max-h-56 overflow-y-auto rounded-xl border py-1 shadow-2xl"
			id="composer-skills-listbox"
			aria-label={`Available ${label}`}
			role={loadState === 'ready' && skills.length > 0 ? 'listbox' : 'status'}
		>
			{loadState === 'loading' ? (
				<p className="text-muted-foreground px-3 py-2 text-sm">Loading {label}…</p>
			) : loadState === 'error' ? (
				<div className="flex items-center justify-between gap-3 px-3 py-2">
					<p className="text-muted-foreground text-sm">Couldn’t load {label}</p>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline"
						onClick={onRetry}
					>
						Retry
					</button>
				</div>
			) : skills.length === 0 ? (
				<p className="text-muted-foreground px-3 py-2 text-sm">No matching {label}</p>
			) : (
				skills.map((skill, index) => (
					<button
						key={skill.name}
						ref={(element) => {
							optionElements.current[index] = element;
						}}
						type="button"
						id={`composer-skill-option-${index}`}
						className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition ${
							highlightedIndex === index
								? 'text-foreground bg-hover-fill-strong'
								: 'text-muted-foreground hover:text-foreground hover:bg-hover-fill'
						}`}
						role="option"
						aria-selected={highlightedIndex === index}
						onPointerEnter={() => onHighlight(index)}
						onClick={() => onSelect(skill)}
					>
						<span className="text-sm font-medium">
							{prefix}
							{skill.name}
						</span>
						<span className="text-muted-foreground line-clamp-2 text-[12px]">
							{skill.description}
						</span>
					</button>
				))
			)}
		</div>
	);
}
