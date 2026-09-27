import { Moon, PanelLeft, Sun } from 'lucide-react';
import type { SprocketTheme } from '$lib/theme';

const buttonClass =
	'text-muted-foreground hover:text-foreground hover:bg-hover-fill inline-flex size-7 shrink-0 items-center justify-center rounded-md transition';

export default function SidebarTopActions({
	theme,
	onThemeChange,
	onClose
}: {
	theme: SprocketTheme;
	onThemeChange: (theme: SprocketTheme) => void;
	onClose?: () => void;
}) {
	return (
		<>
			<button
				type="button"
				className={buttonClass}
				aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
				title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
				onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
			>
				{theme === 'dark' ? (
					<Sun className="size-3.5" aria-hidden="true" />
				) : (
					<Moon className="size-3.5" aria-hidden="true" />
				)}
			</button>
			{onClose && (
				<button
					type="button"
					className={buttonClass}
					aria-label="Close sidebar"
					title="Close sidebar"
					onClick={onClose}
				>
					<PanelLeft className="size-3.5" aria-hidden="true" />
				</button>
			)}
		</>
	);
}
