import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';
import { cn } from '$lib/utils';

type SelectorOption = {
	id: string;
	label: string;
	triggerLabel?: string;
};

export default function OptionSelector<TOption extends SelectorOption>({
	value,
	options,
	ariaLabel,
	menuTitle,
	disabled = false,
	className = '',
	triggerClassName = '',
	searchable = false,
	closeOnSelect = true,
	menuFooter,
	onValueChange,
	optionIcon
}: {
	value: string;
	options: TOption[];
	ariaLabel: string;
	menuTitle: string;
	disabled?: boolean;
	className?: string;
	triggerClassName?: string;
	searchable?: boolean;
	closeOnSelect?: boolean;
	menuFooter?: ReactNode;
	onValueChange?: (value: TOption['id']) => void;
	optionIcon?: (option: TOption) => ReactNode;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const selectedOption = options.find((option) => option.id === value) ?? options[0] ?? null;

	const filteredOptions =
		searchable && searchQuery.trim()
			? options.filter((option) =>
					option.label.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())
				)
			: options;

	function toggleMenu() {
		if (disabled) {
			return;
		}

		const nextOpen = !isOpen;
		setIsOpen(nextOpen);

		if (nextOpen && searchable) queueMicrotask(() => searchRef.current?.focus());
		else setSearchQuery('');
	}

	function selectOption(optionId: TOption['id']) {
		const option = options.find((entry) => entry.id === optionId);

		if (!option) return;

		if (optionId !== value) {
			onValueChange?.(optionId);
		}

		setSearchQuery('');

		if (closeOnSelect) {
			setIsOpen(false);
			triggerRef.current?.focus();
		}
	}

	function handleSearchKeydown(event: React.KeyboardEvent) {
		if (event.key !== 'Enter' || filteredOptions.length === 0) return;
		event.preventDefault();
		selectOption(filteredOptions[0].id);
	}

	useEffect(() => {
		if (!isOpen) {
			setSearchQuery('');

			return;
		}

		return listenOpenMenuDismiss({
			getRoot: () => rootRef.current,
			onOutside: () => {
				setIsOpen(false);
			},
			onEscape: () => {
				setIsOpen(false);
				triggerRef.current?.focus();
			}
		});
	}, [isOpen]);

	useEffect(() => {
		if (disabled) {
			setIsOpen(false);
		}
	}, [disabled]);

	return (
		<div ref={rootRef} className={cn('relative', className)}>
			<button
				ref={triggerRef}
				type="button"
				className={cn(
					'focus-visible:ring-ring/60 text-muted-foreground hover:bg-hover-fill inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium transition outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
					!optionIcon && 'gap-1',
					triggerClassName
				)}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				aria-label={ariaLabel}
				disabled={disabled}
				onClick={toggleMenu}
			>
				{optionIcon && selectedOption ? optionIcon(selectedOption) : null}
				<span className="truncate">
					{selectedOption?.triggerLabel ?? selectedOption?.label ?? value}
				</span>
				<ChevronDown
					className={cn(
						'text-muted-foreground size-3 shrink-0 transition-transform',
						isOpen && 'rotate-180'
					)}
				/>
			</button>

			{isOpen ? (
				<div
					className="bg-popover/96 absolute bottom-[calc(100%+0.75rem)] left-0 z-50 max-h-[60dvh] min-w-[19rem] overflow-y-auto rounded-[18px] border border-[var(--hairline)] p-2 shadow-[var(--composer-shadow)] backdrop-blur-xl"
					role="dialog"
					aria-label={menuTitle}
				>
					{searchable ? (
						<label className="text-muted-foreground flex h-10 items-center gap-2 border-b border-[var(--hairline)] px-2">
							<Search className="size-4 shrink-0" />
							<span className="sr-only">Search {menuTitle.toLocaleLowerCase()}</span>
							<input
								ref={searchRef}
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
								placeholder={`Search ${menuTitle.toLocaleLowerCase()}…`}
								onKeyDown={handleSearchKeydown}
							/>
						</label>
					) : (
						<p className="text-muted-foreground px-3 pt-1 pb-2 text-[11px] font-medium">
							{menuTitle}
						</p>
					)}

					<div className={cn('max-h-64 space-y-0.5 overflow-y-auto', searchable && 'pt-1.5')}>
						{filteredOptions.map((option) => (
							<button
								key={option.id}
								type="button"
								className={cn(
									'focus-visible:ring-ring/60 hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2',
									option.id === value && 'bg-hover-fill'
								)}
								aria-pressed={option.id === value}
								onClick={() => {
									selectOption(option.id);
								}}
							>
								{optionIcon ? (
									<span
										className={cn(
											'flex size-7 shrink-0 items-center justify-center',
											'text-muted-foreground'
										)}
									>
										{optionIcon(option)}
									</span>
								) : null}
								<span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
									{option.label}
								</span>
								<Check
									className={cn(
										'text-accent-strong size-4 shrink-0 transition-opacity',
										option.id === value ? 'opacity-100' : 'opacity-0'
									)}
								/>
							</button>
						))}
						{filteredOptions.length === 0 ? (
							<p className="text-muted-foreground px-3 py-5 text-center text-sm">
								No matches found
							</p>
						) : null}
					</div>
					{menuFooter}
				</div>
			) : null}
		</div>
	);
}
