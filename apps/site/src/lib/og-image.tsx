import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';
import { SITE_NAME, SITE_URL } from '@/lib/seo';

declare module 'react' {
	// Satori renders `corner-shape`, which csstype doesn't list yet.
	interface CSSProperties {
		// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
		cornerShape?: string;
	}
}

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** Hex approximations of the site's oklch tokens for Satori. */
const colors = {
	background: '#edf2e8',
	foreground: '#0c121a',
	accentStrong: '#006ac0',
	accentSoft: '#cbeafb',
	muted: '#575e69'
} as const;

async function loadFont(weight: 400 | 600) {
	const path = `@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff`;

	return {
		name: 'IBM Plex Sans',
		data: await readFile(join(process.cwd(), 'node_modules', path)),
		weight,
		style: 'normal'
	} as const;
}

export async function renderOgImagePng(): Promise<Buffer> {
	const [regular, semibold, logo] = await Promise.all([
		loadFont(400),
		loadFont(600),
		readFile(join(process.cwd(), 'src/assets/logo.svg'))
	]);

	const svg = await satori(
		<div
			style={{
				width: '100%',
				height: '100%',
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'space-between',
				padding: '72px 80px',
				backgroundColor: colors.background,
				backgroundImage:
					'radial-gradient(ellipse 55% 70% at 88% 42%, rgba(203, 234, 251, 0.85) 0%, rgba(237, 242, 232, 0) 68%), radial-gradient(ellipse 40% 50% at 12% 88%, rgba(203, 234, 251, 0.35) 0%, rgba(237, 242, 232, 0) 70%)',
				color: colors.foreground,
				fontFamily: 'IBM Plex Sans'
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
				<img src={`data:image/svg+xml;base64,${logo.toString('base64')}`} width={56} height={56} />
				<div style={{ fontSize: 36, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>
					{SITE_NAME}
				</div>
			</div>
			<div style={{ display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: 920 }}>
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						fontSize: 68,
						fontWeight: 600,
						letterSpacing: '-0.035em',
						lineHeight: 1.12
					}}
				>
					<span>The best AI agent for </span>
					<span
						style={{
							color: colors.accentStrong,
							backgroundColor: colors.accentSoft,
							padding: '0 12px 6px',
							borderRadius: '14px',
							// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
							cornerShape: 'squircle',
							display: 'flex'
						}}
					>
						hardware and software
					</span>
				</div>
				<div
					style={{
						fontSize: 28,
						fontWeight: 400,
						color: colors.muted,
						lineHeight: 1.35,
						maxWidth: 720
					}}
				>
					Sprocket designs electronics, writes and tests code, and can buy anything that's needed
					for your project.
				</div>
			</div>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					fontSize: 22,
					color: colors.muted
				}}
			>
				<span>{new URL(SITE_URL).host}</span>
				<span style={{ color: colors.accentStrong, fontWeight: 600 }}>
					Build more tech, faster.
				</span>
			</div>
		</div>,
		{ width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, fonts: [regular, semibold] }
	);

	return sharp(Buffer.from(svg)).png().toBuffer();
}
