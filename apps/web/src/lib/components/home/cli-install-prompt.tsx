import { LoaderCircle } from 'lucide-react';
import Button from '$lib/components/ui/button/button';

export default function CliInstallPrompt({
	name,
	status,
	disabled,
	onInstall
}: {
	name: string;
	status: { state: string; version: string | null; minimumVersion: string; installCommand: string };
	disabled: boolean;
	onInstall: () => void;
}) {
	const installing = status.state === 'installing';

	return (
		<div className="mt-4 space-y-3">
			<p className="text-muted-foreground text-[12px] leading-5">
				{status.version
					? `${name} ${status.version} is older than ${status.minimumVersion}, which Sprocket needs. Update it with:`
					: `Sprocket uses ${name} on this computer. Install it with:`}
			</p>
			<pre className="border-border bg-hover-fill text-foreground overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[12px]">
				<code>{status.installCommand}</code>
			</pre>
			<Button disabled={disabled || installing} onclick={onInstall}>
				{installing && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
				{installing
					? 'Installing…'
					: status.state === 'outdated'
						? `Update ${name}`
						: `Install ${name}`}
			</Button>
		</div>
	);
}
