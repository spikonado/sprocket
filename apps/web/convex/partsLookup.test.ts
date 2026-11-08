import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedStartedWebJob, type ConvexTestInstance } from '@convex/test.setup';

// Trimmed from real JLCPCB and LCSC responses.
const jlcpcbRows = {
	CL21B105KBFNNNE: [
		{
			componentCode: 'C5137478',
			componentModelEn: 'FCC0805B105K500FT',
			componentBrandEn: 'FOJAN',
			describe:
				'-55℃~+125℃ 1uF 50V X7R ±10% 0805 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS',
			stockCount: 467029,
			componentLibraryType: 'expand',
			preferredComponentFlag: false,
			componentPrices: [{ startNumber: 1, endNumber: 199, productPrice: 0.0247 }],
			minPurchaseNum: 1,
			dataManualUrl: null,
			urlSuffix: 'FOJAN-FCC0805B105K500FT/C5137478'
		},
		{
			componentCode: 'C28323',
			componentModelEn: 'CL21B105KBFNNNE',
			componentBrandEn: 'Samsung Electro-Mechanics',
			describe: '1uF 50V X7R ±10% 0805 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS',
			stockCount: 4294695,
			componentLibraryType: 'base',
			preferredComponentFlag: false,
			componentPrices: [
				{ startNumber: 1, endNumber: 99, productPrice: 0.028 },
				{ startNumber: 100, endNumber: 299, productPrice: 0.022 },
				{ startNumber: 300, endNumber: 1999, productPrice: 0.0192 },
				{ startNumber: 2000, endNumber: 3999, productPrice: 0.0171 },
				{ startNumber: 4000, endNumber: 9999, productPrice: 0.0162 },
				{ startNumber: 10000, endNumber: 49999, productPrice: 0.0157 },
				{ startNumber: 50000, endNumber: -1, productPrice: 0.015 }
			],
			minPurchaseNum: 1,
			dataManualUrl:
				'https://www.lcsc.com/datasheet/lcsc_datasheet_2304140030_Samsung-Electro-Mechanics-CL21B105KBFNNNE_C28323.pdf',
			urlSuffix: '29074-CL21B105KBFNNNE/C28323'
		},
		{
			componentCode: 'C9900046411',
			componentModelEn: 'CL21B105KBFNNNE-YJLTY',
			componentBrandEn: 'JLCPCB Assembly',
			describe: '0805 New Arrivals ROHS',
			stockCount: 0,
			componentLibraryType: 'expand',
			preferredComponentFlag: false,
			componentPrices: [{ startNumber: 1, endNumber: 99, productPrice: 0.0398 }],
			minPurchaseNum: 441,
			dataManualUrl: null,
			urlSuffix: '6551661-CL21B105KBFNNNEYJLTY/C9900046411'
		}
	],
	C2864583: [
		{
			componentCode: 'C2864583',
			componentModelEn: 'TPS55288RPMR',
			componentBrandEn: 'Texas Instruments',
			describe: 'Adjustable Buck-Boost VQFN-26-HR(3.5x4) DC-DC Converters ROHS',
			stockCount: 4231,
			componentLibraryType: 'expand',
			preferredComponentFlag: true,
			componentPrices: [
				{ startNumber: 1, endNumber: 9, productPrice: 2.0934 },
				{ startNumber: 10, endNumber: 29, productPrice: 1.9397 }
			],
			minPurchaseNum: 1,
			dataManualUrl: null,
			urlSuffix: 'TexasInstruments-TPS55288RPMR/C2864583'
		}
	]
};

const lcscProducts = {
	C28323: {
		productCode: 'C28323',
		productModel: 'CL21B105KBFNNNE',
		brandNameEn: 'Samsung Electro-Mechanics',
		productDescEn: '50V 1uF X7R ±10% 0805 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS',
		stockNumber: 4294695,
		minBuyNumber: 20,
		productCycle: 'normal',
		pdfUrl: null,
		productPriceList: [
			{ ladder: 20, productPrice: '0.0287', usdPrice: 0.0287, currencySymbol: '$' },
			{ ladder: 200, productPrice: '0.0225', usdPrice: 0.0225, currencySymbol: '$' }
		]
	},
	C2864583: {
		productCode: 'C2864583',
		productModel: 'TPS55288RPMR',
		brandNameEn: 'TI',
		productDescEn:
			'Buck-Boost Switching Regulator IC Adjustable 0.8V~22V 1 Output 16A VQFN-26-HR(3.5x4)',
		stockNumber: 4231,
		minBuyNumber: 1,
		productCycle: 'normal',
		pdfUrl: null,
		productPriceList: [{ ladder: 1, productPrice: '2.1143', usdPrice: 2.1143, currencySymbol: '$' }]
	}
};

// Shaped after the DigiKey v4 and Mouser v1 OpenAPI specs.
const digikeyProduct = {
	ManufacturerProductNumber: 'TPS55288RPMR',
	Manufacturer: { Id: 296, Name: 'Texas Instruments' },
	Description: {
		ProductDescription: 'IC REG BUCK BOOST ADJ 16A 26VQFN',
		DetailedDescription: 'Buck-Boost Switching Regulator IC Positive Adjustable 0.8V 1 Output 16A'
	},
	ProductUrl: 'https://www.digikey.com/en/products/detail/texas-instruments/TPS55288RPMR/12701283',
	DatasheetUrl: '//www.ti.com/lit/ds/symlink/tps55288.pdf',
	ProductStatus: { Id: 0, Status: 'Active' },
	ProductVariations: [
		{
			DigiKeyProductNumber: '296-TPS55288RPMRTR-ND',
			PackageType: { Id: 1, Name: 'Tape & Reel (TR)' },
			StandardPricing: [{ BreakQuantity: 3000, UnitPrice: 2.1, TotalPrice: 6300 }],
			QuantityAvailableforPackageType: 9000,
			MinimumOrderQuantity: 3000,
			MarketPlace: false
		},
		{
			DigiKeyProductNumber: '296-TPS55288RPMRCT-ND',
			PackageType: { Id: 2, Name: 'Cut Tape (CT)' },
			StandardPricing: [
				{ BreakQuantity: 1, UnitPrice: 4.79, TotalPrice: 4.79 },
				{ BreakQuantity: 10, UnitPrice: 3.98, TotalPrice: 39.8 }
			],
			QuantityAvailableforPackageType: 1520,
			MinimumOrderQuantity: 1,
			MarketPlace: false
		}
	]
};

const mouserPart = {
	MouserPartNumber: '595-TPS55288RPMR',
	ManufacturerPartNumber: 'TPS55288RPMR',
	Manufacturer: 'Texas Instruments',
	Description: 'Switching Voltage Regulators 36-V, 16-A buck-boost converter',
	AvailabilityInStock: '2735',
	Min: '1',
	LifecycleStatus: null,
	IsDiscontinued: 'false',
	DataSheetUrl: '',
	ProductDetailUrl: 'https://www.mouser.com/ProductDetail/Texas-Instruments/TPS55288RPMR',
	PriceBreaks: [
		{ Quantity: 1, Price: '$4.80', RawPrice: 4.8, Currency: 'USD' },
		{ Quantity: 10, Price: '$3.99', RawPrice: 3.99, Currency: 'USD' }
	]
};

type Reply = { status?: number; body: object; headers?: HeadersInit };

function stubDistributors(overrides: { digikey?: () => Reply; mouser?: () => Reply } = {}) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const jsonBody = <T>(schema: z.ZodType<T>) => schema.parse(JSON.parse(String(init?.body)));

		const route = (): Reply => {
			if (url.hostname === 'jlcpcb.com') {
				const { keyword } = jsonBody(z.object({ keyword: z.string() }));

				return {
					body: {
						code: 200,
						data: {
							componentPageInfo: { list: new Map(Object.entries(jlcpcbRows)).get(keyword) ?? [] }
						}
					}
				};
			}

			if (url.hostname === 'wmsc.lcsc.com') {
				const code = url.searchParams.get('productCode') ?? '';

				return {
					body: {
						code: 200,
						msg: null,
						result: new Map(Object.entries(lcscProducts)).get(code) ?? null
					}
				};
			}

			if (url.pathname === '/v1/oauth2/token') {
				return { body: { access_token: 'digikey-token', expires_in: 599, token_type: 'Bearer' } };
			}

			if (url.hostname === 'api.digikey.com') {
				if (overrides.digikey) return overrides.digikey();

				const { Keywords } = jsonBody(z.object({ Keywords: z.string() }));

				return {
					body: {
						Products: [],
						ExactMatches: Keywords === 'TPS55288RPMR' ? [digikeyProduct] : []
					}
				};
			}

			if (url.hostname === 'api.mouser.com') {
				if (overrides.mouser) return overrides.mouser();

				const { SearchByPartRequest: request } = jsonBody(
					z.object({ SearchByPartRequest: z.object({ mouserPartNumber: z.string() }) })
				);

				return {
					body: {
						Errors: [],
						SearchResults: {
							Parts: request.mouserPartNumber.split('|').includes('TPS55288RPMR')
								? [mouserPart]
								: []
						}
					}
				};
			}

			throw new Error(`Unexpected request to ${url.toString()}`);
		};

		const { status = 200, body: responseBody, headers } = route();

		return new Response(JSON.stringify(responseBody), { status, headers });
	});

	vi.stubGlobal('fetch', fetchMock);

	return (hostname: string) =>
		fetchMock.mock.calls.filter(([input]) => new URL(String(input)).hostname === hostname);
}

async function lookup(t: ConvexTestInstance, parts: string[], quantity?: number) {
	const job = await seedStartedWebJob(t, {
		executionSecret: crypto.randomUUID(),
		kind: 'lookup_parts',
		payload: quantity === undefined ? { parts } : { parts, quantity }
	});

	return await t.action(internal.partsLookup.execute, {
		jobId: job.jobId,
		runId: job.runId,
		claimId: job.claimId
	});
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('lookup_parts', () => {
	it('maps MPNs and LCSC codes through JLCPCB and caches each source', async () => {
		const t = initConvexTest();
		const calls = stubDistributors();

		const result = await lookup(t, ['CL21B105KBFNNNE', 'c2864583', 'NOPE-123'], 100);

		expect(result.unavailable).toEqual({ digikey: 'not configured', mouser: 'not configured' });
		expect(result.parts.map((part) => part.part)).toEqual([
			'CL21B105KBFNNNE',
			'c2864583',
			'NOPE-123'
		]);

		const [capacitor, converter, missing] = result.parts;
		expect(capacitor?.errors).toBeUndefined();
		expect(capacitor?.offers).toEqual([
			{
				source: 'jlcpcb',
				sku: 'C28323',
				mpn: 'CL21B105KBFNNNE',
				manufacturer: 'Samsung Electro-Mechanics',
				description: '1uF 50V X7R ±10% 0805 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS',
				stock: 4294695,
				unitPrice: 0.022,
				priceBreaks: [
					{ quantity: 100, price: 0.022 },
					{ quantity: 300, price: 0.0192 },
					{ quantity: 2000, price: 0.0171 },
					{ quantity: 4000, price: 0.0162 },
					{ quantity: 10000, price: 0.0157 }
				],
				moq: 1,
				library: 'basic',
				datasheet: jlcpcbRows.CL21B105KBFNNNE[1]!.dataManualUrl,
				url: 'https://jlcpcb.com/partdetail/29074-CL21B105KBFNNNE/C28323'
			},
			{
				source: 'lcsc',
				sku: 'C28323',
				mpn: 'CL21B105KBFNNNE',
				manufacturer: 'Samsung Electro-Mechanics',
				description: '50V 1uF X7R ±10% 0805 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS',
				stock: 4294695,
				unitPrice: 0.0287,
				priceBreaks: [
					{ quantity: 20, price: 0.0287 },
					{ quantity: 200, price: 0.0225 }
				],
				moq: 20,
				status: 'normal',
				url: 'https://www.lcsc.com/product-detail/C28323.html'
			}
		]);
		expect(converter?.offers.map(({ source, mpn, library }) => ({ source, mpn, library }))).toEqual(
			[
				{ source: 'jlcpcb', mpn: 'TPS55288RPMR', library: 'preferred' },
				{ source: 'lcsc', mpn: 'TPS55288RPMR', library: undefined }
			]
		);
		expect(missing).toEqual({
			part: 'NOPE-123',
			offers: [],
			errors: { jlcpcb: 'not found', lcsc: 'not found' }
		});

		expect(calls('jlcpcb.com')).toHaveLength(3);
		expect(calls('wmsc.lcsc.com')).toHaveLength(2);

		await lookup(t, ['CL21B105KBFNNNE', 'C2864583', 'NOPE-123'], 100);
		expect(calls('jlcpcb.com')).toHaveLength(3);
		expect(calls('wmsc.lcsc.com')).toHaveLength(2);
	});

	it('adds DigiKey and Mouser offers and batches Mouser by ten part numbers', async () => {
		vi.stubEnv('DIGIKEY_CLIENT_ID', 'client');
		vi.stubEnv('DIGIKEY_CLIENT_SECRET', 'secret');
		vi.stubEnv('MOUSER_API_KEY', 'mouser-key');
		const t = initConvexTest();
		const calls = stubDistributors();

		const others = Array.from({ length: 10 }, (_, index) => `PART-${index}`);
		const result = await lookup(t, ['TPS55288RPMR', ...others]);

		expect(result.unavailable).toBeUndefined();
		expect(result.parts[0]?.errors).toEqual({ jlcpcb: 'not found', lcsc: 'not found' });
		expect(result.parts[0]?.offers).toEqual([
			{
				source: 'digikey',
				sku: '296-TPS55288RPMRCT-ND',
				mpn: 'TPS55288RPMR',
				manufacturer: 'Texas Instruments',
				description: 'Buck-Boost Switching Regulator IC Positive Adjustable 0.8V 1 Output 16A',
				stock: 1520,
				unitPrice: 4.79,
				priceBreaks: [
					{ quantity: 1, price: 4.79 },
					{ quantity: 10, price: 3.98 }
				],
				moq: 1,
				status: 'Active',
				packaging: 'Cut Tape (CT)',
				datasheet: 'https://www.ti.com/lit/ds/symlink/tps55288.pdf',
				url: digikeyProduct.ProductUrl
			},
			expect.objectContaining({ sku: '296-TPS55288RPMRTR-ND', moq: 3000, unitPrice: 2.1 }),
			{
				source: 'mouser',
				sku: '595-TPS55288RPMR',
				mpn: 'TPS55288RPMR',
				manufacturer: 'Texas Instruments',
				description: 'Switching Voltage Regulators 36-V, 16-A buck-boost converter',
				stock: 2735,
				unitPrice: 4.8,
				priceBreaks: [
					{ quantity: 1, price: 4.8 },
					{ quantity: 10, price: 3.99 }
				],
				moq: 1,
				url: mouserPart.ProductDetailUrl
			}
		]);
		expect(result.parts[1]?.errors).toEqual({
			jlcpcb: 'not found',
			lcsc: 'not found',
			digikey: 'not found',
			mouser: 'not found'
		});

		expect(calls('api.digikey.com')).toHaveLength(12);
		expect(
			calls('api.mouser.com').map(
				([, init]) =>
					JSON.parse(String(init?.body)).SearchByPartRequest.mouserPartNumber.split('|').length
			)
		).toEqual([10, 1]);
	});

	it('reports source failures inside the result without caching them', async () => {
		vi.stubEnv('DIGIKEY_CLIENT_ID', 'client');
		vi.stubEnv('DIGIKEY_CLIENT_SECRET', 'secret');
		vi.stubEnv('MOUSER_API_KEY', 'bad-key');
		const t = initConvexTest();

		const calls = stubDistributors({
			digikey: () => ({
				status: 429,
				headers: { 'Retry-After': '86400' },
				body: { StatusCode: 429, ErrorMessage: 'Daily Ratelimit exceeded' }
			}),
			mouser: () => ({
				body: {
					Errors: [
						{ Code: 'Invalid', Message: 'Invalid unique identifier.', PropertyName: 'API Key' }
					],
					SearchResults: null
				}
			})
		});

		const result = await lookup(t, ['C2864583']);

		expect(result.parts[0]?.offers.map((offer) => offer.source)).toEqual(['jlcpcb', 'lcsc']);
		expect(result.parts[0]?.errors).toEqual({
			digikey: 'rate limited',
			mouser: 'rejected the API key'
		});

		await lookup(t, ['C2864583']);
		expect(calls('api.mouser.com')).toHaveLength(2);
	});

	it('rejects more than 50 parts', async () => {
		const t = initConvexTest();
		const calls = stubDistributors();

		await expect(
			lookup(
				t,
				Array.from({ length: 51 }, (_, index) => `PART-${index}`)
			)
		).rejects.toThrow('List 1 to 50 part numbers.');
		expect(calls('jlcpcb.com')).toHaveLength(0);
	});
});
