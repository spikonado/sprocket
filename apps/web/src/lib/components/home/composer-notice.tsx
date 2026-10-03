import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

type Props = {
	title: string;
	children: ReactNode;
	tone?: 'error' | 'warning' | 'status';
	action?: ReactNode;
};

export default function ComposerNotice({ title, children, tone = 'warning', action }: Props) {
	return (
		<div
			className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${
				tone === 'error'
					? 'border-rose-500/25 bg-rose-500/10 text-rose-800 dark:text-rose-200'
					: 'border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-200'
			}`}
			role={tone === 'status' ? 'status' : 'alert'}
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
				<p className="text-[13px] leading-5 font-medium">{title}</p>
				<div className="text-[12.5px] leading-5 opacity-90">{children}</div>
				{action ? <div className="mt-2">{action}</div> : null}
			</div>
		</div>
	);
}
