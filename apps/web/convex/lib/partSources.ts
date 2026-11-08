import type { Infer } from 'convex/values';
import { z } from 'zod';
import { env } from '@convex/_generated/server';
import { retryAfterHeaderMs, retryRateLimited } from '@convex/lib/providerRetry';
import type { PartSource, vPartListing } from '@convex/lib/validators';

export type PartListing = Infer<typeof vPartListing>;

export type SourceOutcome = { listings: PartListing[] } | { error: string };

export type SourceLimits = { deadline: number };

export const MAX_LISTINGS_PER_SOURCE = 3;

const REQUEST_TIMEOUT_MS = 20_000;

const REQUESTS_IN_FLIGHT = 4;

const DESCRIPTION_MAX_CHARS = 160;

const MOUSER_BATCH_SIZE = 10;

// JLCPCB and LCSC have no public API; these are the JSON endpoints their own sites call.
const JLCPCB_SEARCH_URL =
	'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2';

const LCSC_DETAIL_URL = 'https://wmsc.lcsc.com/ftps/wm/product/detail';

const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DIGIKEY_API = 'https://api.digikey.com';

const MOUSER_SEARCH_URL = 'https://api.mouser.com/api/v1/search/partnumber';

export class SourceError extends Error {
	constructor(
		message: string,
		readonly options: { status?: number; rateLimitedForMs?: number } = {}
	) {
		super(message);
	}
}

export function normalizePartNumber(value: string): string {
	return value.trim().toUpperCase().replace(/\s+/g, '');
}

export function isLcscCode(value: string): boolean {
	return /^C\d+$/.test(normalizePartNumber(value));
}

function clipDescription(value: string | null | undefined): string | undefined {
	const text = value?.trim().replace(/\s+/g, ' ');

	if (!text) return undefined;

	return text.length > DESCRIPTION_MAX_CHARS
		? `${text.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`
		: text;
}

function present<T>(value: T | null | undefined): T | undefined {
	return value ?? undefined;
}

/** Runs `lookup` for every key with bounded concurrency; a failure only affects its own key. */
async function lookupEach(
	keys: string[],
	lookup: (key: string) => Promise<PartListing[]>
): Promise<Map<string, SourceOutcome>> {
	const outcomes = new Map<string, SourceOutcome>();
	let next = 0;

	const worker = async () => {
		while (next < keys.length) {
			const key = keys[next++]!;

			try {
				outcomes.set(key, { listings: await lookup(key) });
			} catch (error) {
				if (!(error instanceof SourceError)) throw error;

				outcomes.set(key, { error: error.message });
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(REQUESTS_IN_FLIGHT, keys.length) }, worker));

	return outcomes;
}

function httpError(response: Response): SourceError {
	if (response.status === 429) {
		return new SourceError('rate limited', {
			status: response.status,
			rateLimitedForMs: retryAfterHeaderMs(response.headers.get('retry-after'))
		});
	}

	return new SourceError(`failed (HTTP ${response.status})`, { status: response.status });
}

async function requestJson<T>(
	url: string,
	init: RequestInit,
	schema: z.ZodType<T>,
	{ deadline }: SourceLimits
): Promise<T> {
	return await retryRateLimited({
		deadline,
		maxAttemptMs: REQUEST_TIMEOUT_MS,
		attempt: async (timeoutMs) => {
			const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

			if (!response.ok) throw httpError(response);
			const parsed = schema.safeParse(await response.json());

			if (!parsed.success) throw new SourceError('returned an unexpected response');

			return parsed.data;
		},
		retryAfterMs: (error) =>
			error instanceof SourceError ? error.options.rateLimitedForMs : undefined,
		failure: (error) =>
			error instanceof SourceError
				? error
				: new SourceError(error.name === 'TimeoutError' ? 'timed out' : 'request failed'),
		shouldContinue: async () => true
	});
}

/** Exact part-number matches only when there are any, otherwise the best few candidates. */
export function pickListings(query: string, listings: PartListing[]): PartListing[] {
	const exact = listings.filter((listing) => isExactListing(listing, query));

	return (exact.length > 0 ? exact : listings).slice(0, MAX_LISTINGS_PER_SOURCE);
}

export function isExactListing(listing: PartListing, partNumber: string): boolean {
	const wanted = normalizePartNumber(partNumber);

	return normalizePartNumber(listing.mpn) === wanted || normalizePartNumber(listing.sku) === wanted;
}

const nullableString = z.string().nullish();

const jlcpcbComponent = z.object({
	componentCode: z.string(),
	componentModelEn: z.string(),
	componentBrandEn: nullableString,
	describe: nullableString,
	stockCount: z.number().nullish(),
	componentLibraryType: nullableString,
	preferredComponentFlag: z.boolean().nullish(),
	componentPrices: z
		.array(z.object({ startNumber: z.number(), productPrice: z.number() }))
		.nullish(),
	minPurchaseNum: z.number().nullish(),
	dataManualUrl: nullableString,
	urlSuffix: nullableString
});

const jlcpcbResponse = z.object({
	code: z.number(),
	message: nullableString,
	data: z
		.object({
			componentPageInfo: z.object({ list: z.array(jlcpcbComponent).nullish() }).nullish()
		})
		.nullish()
});

function jlcpcbLibrary(component: z.infer<typeof jlcpcbComponent>): PartListing['library'] {
	if (component.preferredComponentFlag) return 'preferred';

	if (component.componentLibraryType === 'base') return 'basic';

	return component.componentLibraryType === 'expand' ? 'extended' : undefined;
}

async function searchJlcpcb(query: string, limits: SourceLimits): Promise<PartListing[]> {
	const response = await requestJson(
		JLCPCB_SEARCH_URL,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_USER_AGENT },
			body: JSON.stringify({ currentPage: 1, pageSize: 5, keyword: query, searchType: 2 })
		},
		jlcpcbResponse,
		limits
	);

	if (response.code !== 200) {
		throw new SourceError(`failed: ${response.message ?? `code ${response.code}`}`);
	}

	const listings = (response.data?.componentPageInfo?.list ?? []).flatMap(
		(component): PartListing[] => {
			const stock = component.stockCount ?? 0;

			// Consignment rows for parts customers shipped to JLCPCB themselves.
			if (stock === 0 && component.componentModelEn.endsWith('-YJLTY')) return [];

			return [
				{
					source: 'jlcpcb',
					sku: component.componentCode,
					mpn: component.componentModelEn,
					manufacturer: present(component.componentBrandEn),
					description: clipDescription(component.describe),
					stock,
					priceBreaks: (component.componentPrices ?? []).map((price) => ({
						quantity: price.startNumber,
						price: price.productPrice
					})),
					moq: present(component.minPurchaseNum),
					library: jlcpcbLibrary(component),
					datasheet: present(component.dataManualUrl),
					url: component.urlSuffix
						? `https://jlcpcb.com/partdetail/${component.urlSuffix}`
						: undefined
				}
			];
		}
	);

	return pickListings(query, listings);
}

/** Also maps MPNs to LCSC part numbers, since LCSC's own search is not usable. */
export async function lookupJlcpcb(
	queries: string[],
	limits: SourceLimits
): Promise<Map<string, SourceOutcome>> {
	return await lookupEach(queries, async (query) => await searchJlcpcb(query, limits));
}

const lcscResponse = z.object({
	code: z.number(),
	msg: nullableString,
	result: z
		.object({
			productCode: z.string(),
			productModel: z.string(),
			brandNameEn: nullableString,
			productDescEn: nullableString,
			productIntroEn: nullableString,
			stockNumber: z.number().nullish(),
			minBuyNumber: z.number().nullish(),
			productCycle: nullableString,
			pdfUrl: nullableString,
			productPriceList: z.array(z.object({ ladder: z.number(), usdPrice: z.number() })).nullish()
		})
		.nullish()
});

async function fetchLcsc(code: string, limits: SourceLimits): Promise<PartListing[]> {
	const url = new URL(LCSC_DETAIL_URL);
	url.searchParams.set('productCode', code);

	const response = await requestJson(
		url.toString(),
		{ headers: { 'User-Agent': BROWSER_USER_AGENT } },
		lcscResponse,
		limits
	);

	if (response.code !== 200) {
		throw new SourceError(`failed: ${response.msg ?? `code ${response.code}`}`);
	}

	const product = response.result;

	if (!product) return [];

	return [
		{
			source: 'lcsc',
			sku: product.productCode,
			mpn: product.productModel,
			manufacturer: present(product.brandNameEn),
			description: clipDescription(product.productDescEn ?? product.productIntroEn),
			stock: product.stockNumber ?? 0,
			priceBreaks: (product.productPriceList ?? []).map((price) => ({
				quantity: price.ladder,
				price: price.usdPrice
			})),
			moq: present(product.minBuyNumber),
			status: present(product.productCycle),
			datasheet: present(product.pdfUrl),
			url: `https://www.lcsc.com/product-detail/${product.productCode}.html`
		}
	];
}

export async function lookupLcsc(
	codes: string[],
	limits: SourceLimits
): Promise<Map<string, SourceOutcome>> {
	return await lookupEach(codes, async (code) => await fetchLcsc(code, limits));
}

export function sourceConfigured(source: PartSource): boolean {
	if (source === 'digikey') {
		return Boolean(env.DIGIKEY_CLIENT_ID?.trim() && env.DIGIKEY_CLIENT_SECRET?.trim());
	}

	if (source === 'mouser') return Boolean(env.MOUSER_API_KEY?.trim());

	return true;
}

const digikeyTokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });

const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Survives between actions that reuse a warm isolate; a cold one fetches a new token.
let digikeyToken: { value: string; refreshAt: number } | undefined;

async function digikeyAccessToken(limits: SourceLimits): Promise<string> {
	if (digikeyToken && digikeyToken.refreshAt > Date.now()) return digikeyToken.value;

	const body = await requestJson(
		`${DIGIKEY_API}/v1/oauth2/token`,
		{
			method: 'POST',
			body: new URLSearchParams({
				client_id: env.DIGIKEY_CLIENT_ID?.trim() ?? '',
				client_secret: env.DIGIKEY_CLIENT_SECRET?.trim() ?? '',
				grant_type: 'client_credentials'
			})
		},
		digikeyTokenResponse,
		limits
	);

	digikeyToken = {
		value: body.access_token,
		refreshAt: Date.now() + body.expires_in * 1_000 - TOKEN_REFRESH_MARGIN_MS
	};

	return digikeyToken.value;
}

const digikeyProduct = z.object({
	ManufacturerProductNumber: z.string(),
	Manufacturer: z.object({ Name: nullableString }).nullish(),
	Description: z
		.object({ ProductDescription: nullableString, DetailedDescription: nullableString })
		.nullish(),
	ProductUrl: nullableString,
	DatasheetUrl: nullableString,
	ProductStatus: z.object({ Status: nullableString }).nullish(),
	ProductVariations: z
		.array(
			z.object({
				DigiKeyProductNumber: z.string(),
				PackageType: z.object({ Name: nullableString }).nullish(),
				StandardPricing: z
					.array(z.object({ BreakQuantity: z.number(), UnitPrice: z.number() }))
					.nullish(),
				QuantityAvailableforPackageType: z.number().nullish(),
				MinimumOrderQuantity: z.number().nullish(),
				MarketPlace: z.boolean().nullish()
			})
		)
		.nullish()
});

const digikeyKeywordResponse = z.object({
	Products: z.array(digikeyProduct).nullish(),
	ExactMatches: z.array(digikeyProduct).nullish()
});

function absoluteUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;

	return value.startsWith('//') ? `https:${value}` : value;
}

async function searchDigikey(
	mpn: string,
	token: string,
	limits: SourceLimits
): Promise<PartListing[]> {
	const response = await requestJson(
		`${DIGIKEY_API}/products/v4/search/keyword`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'X-DIGIKEY-Client-Id': env.DIGIKEY_CLIENT_ID?.trim() ?? '',
				'X-DIGIKEY-Locale-Site': 'US',
				'X-DIGIKEY-Locale-Language': 'en',
				'X-DIGIKEY-Locale-Currency': 'USD',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ Keywords: mpn, Limit: 5 })
		},
		digikeyKeywordResponse,
		limits
	);

	const exact = response.ExactMatches ?? [];
	const products = exact.length > 0 ? exact : (response.Products ?? []);

	const listings = products.flatMap((product) =>
		(product.ProductVariations ?? [])
			.filter((variation) => !variation.MarketPlace)
			.map((variation): PartListing => ({
				source: 'digikey',
				sku: variation.DigiKeyProductNumber,
				mpn: product.ManufacturerProductNumber,
				manufacturer: present(product.Manufacturer?.Name),
				description: clipDescription(
					product.Description?.DetailedDescription ?? product.Description?.ProductDescription
				),
				stock: variation.QuantityAvailableforPackageType ?? 0,
				priceBreaks: (variation.StandardPricing ?? []).map((price) => ({
					quantity: price.BreakQuantity,
					price: price.UnitPrice
				})),
				moq: present(variation.MinimumOrderQuantity),
				status: present(product.ProductStatus?.Status),
				packaging: present(variation.PackageType?.Name),
				datasheet: absoluteUrl(product.DatasheetUrl),
				url: present(product.ProductUrl)
			}))
			.sort((a, b) => (a.moq ?? 1) - (b.moq ?? 1))
	);

	return pickListings(mpn, listings);
}

export async function lookupDigikey(
	mpns: string[],
	limits: SourceLimits
): Promise<Map<string, SourceOutcome>> {
	let token: string;

	try {
		token = await digikeyAccessToken(limits);
	} catch (error) {
		if (!(error instanceof SourceError)) throw error;

		const outcome = {
			error: error.options.status === 401 ? 'rejected the API key' : error.message
		};

		return new Map(mpns.map((mpn) => [mpn, outcome]));
	}

	return await lookupEach(mpns, async (mpn) => await searchDigikey(mpn, token, limits));
}

const mouserResponse = z.object({
	Errors: z
		.array(
			z.object({ Code: nullableString, Message: nullableString, PropertyName: nullableString })
		)
		.nullish(),
	SearchResults: z
		.object({
			Parts: z
				.array(
					z.object({
						MouserPartNumber: nullableString,
						ManufacturerPartNumber: nullableString,
						Manufacturer: nullableString,
						Description: nullableString,
						AvailabilityInStock: nullableString,
						Min: nullableString,
						LifecycleStatus: nullableString,
						IsDiscontinued: nullableString,
						DataSheetUrl: nullableString,
						ProductDetailUrl: nullableString,
						PriceBreaks: z
							.array(
								z.object({
									Quantity: z.number(),
									Price: nullableString,
									RawPrice: z.number().nullish(),
									Currency: nullableString
								})
							)
							.nullish()
					})
				)
				.nullish()
		})
		.nullish()
});

type MouserPart = NonNullable<
	NonNullable<z.infer<typeof mouserResponse>['SearchResults']>['Parts']
>[number];

function parseCount(value: string | null | undefined): number | undefined {
	const count = Number.parseInt(value?.replace(/[^\d]/g, '') ?? '', 10);

	return Number.isFinite(count) ? count : undefined;
}

function parseMouserPrice(price: string | null | undefined): number | undefined {
	const amount = Number.parseFloat(price?.replace(/[^\d.,]/g, '').replace(',', '.') ?? '');

	return Number.isFinite(amount) ? amount : undefined;
}

function mouserListing(part: MouserPart): PartListing | null {
	if (!part.MouserPartNumber || part.MouserPartNumber === 'N/A' || !part.ManufacturerPartNumber) {
		return null;
	}

	const breaks = part.PriceBreaks ?? [];
	const currency = breaks.find((price) => price.Currency)?.Currency ?? undefined;

	return {
		source: 'mouser',
		sku: part.MouserPartNumber,
		mpn: part.ManufacturerPartNumber,
		manufacturer: present(part.Manufacturer),
		description: clipDescription(part.Description),
		stock: parseCount(part.AvailabilityInStock) ?? 0,
		priceBreaks: breaks.flatMap((price) => {
			const amount = price.RawPrice ?? parseMouserPrice(price.Price);

			return amount === undefined ? [] : [{ quantity: price.Quantity, price: amount }];
		}),
		currency: currency && currency !== 'USD' ? currency : undefined,
		moq: parseCount(part.Min),
		status:
			present(part.LifecycleStatus) ??
			(part.IsDiscontinued === 'true' ? 'Discontinued' : undefined),
		datasheet: part.DataSheetUrl || undefined,
		url: present(part.ProductDetailUrl)
	};
}

async function searchMouser(
	mpns: string[],
	limits: SourceLimits
): Promise<Map<string, PartListing[]>> {
	const url = new URL(MOUSER_SEARCH_URL);
	url.searchParams.set('apiKey', env.MOUSER_API_KEY?.trim() ?? '');

	const response = await requestJson(
		url.toString(),
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({
				SearchByPartRequest: { mouserPartNumber: mpns.join('|'), partSearchOptions: 'Exact' }
			})
		},
		mouserResponse,
		limits
	);

	const error = response.Errors?.[0];

	if (error) {
		if (error.PropertyName === 'API Key') throw new SourceError('rejected the API key');

		const message = error.Message ?? error.Code ?? 'unknown error';

		throw new SourceError(
			/limit|exceed|too many/i.test(message) ? 'rate limited' : `failed: ${message}`
		);
	}

	const listings = (response.SearchResults?.Parts ?? []).flatMap((part) => {
		const listing = mouserListing(part);

		return listing ? [listing] : [];
	});

	return new Map(
		mpns.map((mpn) => [
			mpn,
			listings.filter((listing) => isExactListing(listing, mpn)).slice(0, MAX_LISTINGS_PER_SOURCE)
		])
	);
}

/** Mouser takes up to 10 part numbers per call, and its 30 calls a minute are shared. */
export async function lookupMouser(
	mpns: string[],
	limits: SourceLimits
): Promise<Map<string, SourceOutcome>> {
	const outcomes = new Map<string, SourceOutcome>();

	const searchable = mpns.filter((mpn) => {
		const valid = mpn.length >= 3 && mpn.length <= 40;

		if (!valid) outcomes.set(mpn, { listings: [] });

		return valid;
	});

	for (let start = 0; start < searchable.length; start += MOUSER_BATCH_SIZE) {
		const batch = searchable.slice(start, start + MOUSER_BATCH_SIZE);

		try {
			for (const [mpn, listings] of await searchMouser(batch, limits)) {
				outcomes.set(mpn, { listings });
			}
		} catch (error) {
			if (!(error instanceof SourceError)) throw error;

			for (const mpn of batch) outcomes.set(mpn, { error: error.message });
		}
	}

	return outcomes;
}
