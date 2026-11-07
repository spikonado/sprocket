import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';
import { SITE_NAME } from '@/lib/seo';

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

async function loadFont(relativePath: string): Promise<ArrayBuffer> {
	const buffer = await readFile(join(process.cwd(), 'node_modules', relativePath));
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function loadLogoDataUrl(): Promise<string> {
	const buffer = await readFile(join(process.cwd(), 'src/assets/logo.svg'));
	return `data:image/svg+xml;base64,${buffer.toString('base64')}`;
}

export async function renderOgImagePng(): Promise<Buffer> {
	const [regular, semibold, logo] = await Promise.all([
		loadFont('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff'),
		loadFont('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff'),
		loadLogoDataUrl()
	]);

	const svg = await satori(
		{
			type: 'div',
			props: {
				style: {
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
				},
				children: [
					{
						type: 'div',
						props: {
							style: {
								display: 'flex',
								alignItems: 'center',
								gap: '18px'
							},
							children: [
								{
									type: 'img',
									props: {
										src: logo,
										width: 56,
										height: 56,
										style: { borderRadius: '12px' }
									}
								},
								{
									type: 'div',
									props: {
										style: {
											fontSize: 36,
											fontWeight: 600,
											letterSpacing: '-0.02em',
											lineHeight: 1
										},
										children: SITE_NAME
									}
								}
							]
						}
					},
					{
						type: 'div',
						props: {
							style: {
								display: 'flex',
								flexDirection: 'column',
								gap: '28px',
								maxWidth: 920
							},
							children: [
								{
									type: 'div',
									props: {
										style: {
											display: 'flex',
											flexWrap: 'wrap',
											fontSize: 68,
											fontWeight: 600,
											letterSpacing: '-0.035em',
											lineHeight: 1.12
										},
										children: [
											{
												type: 'span',
												props: {
													children: 'A way for anyone to build '
												}
											},
											{
												type: 'span',
												props: {
													style: {
														color: colors.accentStrong,
														backgroundColor: colors.accentSoft,
														padding: '0 12px 6px',
														borderRadius: '10px',
														display: 'flex'
													},
													children: 'any kind of technology'
												}
											}
										]
									}
								},
								{
									type: 'div',
									props: {
										style: {
											fontSize: 28,
											fontWeight: 400,
											color: colors.muted,
											lineHeight: 1.35,
											maxWidth: 720
										},
										children:
											'Build apps, robots, devices, and the systems that glue them together.'
									}
								}
							]
						}
					},
					{
						type: 'div',
						props: {
							style: {
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								fontSize: 22,
								color: colors.muted
							},
							children: [
								{
									type: 'span',
									props: { children: 'spikonado.com' }
								},
								{
									type: 'span',
									props: {
										style: {
											display: 'flex',
											alignItems: 'center',
											gap: '10px',
											color: colors.accentStrong,
											fontWeight: 600
										},
										children: 'Build more tech, faster.'
									}
								}
							]
						}
					}
				]
			}
		},
		{
			width: OG_IMAGE_WIDTH,
			height: OG_IMAGE_HEIGHT,
			fonts: [
				{ name: 'IBM Plex Sans', data: regular, weight: 400, style: 'normal' },
				{ name: 'IBM Plex Sans', data: semibold, weight: 600, style: 'normal' }
			]
		}
	);

	return sharp(Buffer.from(svg)).png().toBuffer();
}
