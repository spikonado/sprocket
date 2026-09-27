import { ArrowLeft, ChartNoAxesColumn, CreditCard, KeyRound, UserRound } from 'lucide-react';
import SidebarTopActions from '$lib/components/home/sidebar-top-actions';
import type { SprocketTheme } from '$lib/theme';

export type SettingsPage = 'account' | 'usage' | 'providers' | 'payments';

const navItems: ReadonlyArray<{ id: SettingsPage; label: string; icon: typeof UserRound }> = [
	{ id: 'account', label: 'Account', icon: UserRound },
	{ id: 'usage', label: 'Usage', icon: ChartNoAxesColumn },
	{ id: 'providers', label: 'BYOK/BYOS', icon: KeyRound },
	{ id: 'payments', label: 'Payments', icon: CreditCard }
];

const navItemClass =
	'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition';
const navItemActiveClass = 'bg-hover-fill-strong text-foreground';
const navItemIdleClass = 'text-muted-foreground hover:bg-hover-fill hover:text-foreground';

export default function SettingsSidebar({
	activePage,
	theme,
	onThemeChange,
	onBack,
	onNavigate
}: {
	activePage: SettingsPage;
	theme: SprocketTheme;
	onThemeChange: (theme: SprocketTheme) => void;
	onBack: () => void;
	onNavigate: (page: SettingsPage) => void;
}) {
	return (
		<aside className="app-sidebar-panel">
			<div className="flex h-full min-h-0 flex-col overflow-hidden">
				<div className="flex items-center justify-between gap-2 px-3.5 pt-3 pb-3">
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground hover:bg-hover-fill inline-flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition"
						onClick={onBack}
					>
						<ArrowLeft className="size-3.5" aria-hidden="true" />
						Back
					</button>
					<SidebarTopActions theme={theme} onThemeChange={onThemeChange} />
				</div>

				<nav
					className="hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-4"
					aria-label="Settings"
				>
					{navItems.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`${navItemClass} ${activePage === item.id ? navItemActiveClass : navItemIdleClass}`}
							aria-current={activePage === item.id ? 'page' : undefined}
							onClick={() => {
								onNavigate(item.id);
							}}
						>
							<item.icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
							<span className="truncate">{item.label}</span>
						</button>
					))}
				</nav>
			</div>
		</aside>
	);
}
