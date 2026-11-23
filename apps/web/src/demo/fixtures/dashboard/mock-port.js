const SPEEDUP = 30;
const UNPLUGGED_S = 300;
const CHARGE_MV = 4200;

/** Stands in for the board until one is built: 5 minutes on the cell, then USB plugged in, at 30× speed. */
export function mockPort() {
	let seconds = 0;
	let timer;

	return {
		open: async () => {},
		readable: new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				timer = setInterval(() => {
					seconds += 1;
					const usb = seconds > UNPLUGGED_S;
					const charging = Math.min(CHARGE_MV, 4080 + 0.3 * (seconds - UNPLUGGED_S));
					const trend = usb ? charging : 4050 - 0.4 * seconds;
					const vbat_mv = Math.round(trend + 6 * (Math.random() - 0.5));
					const sample = { ms: seconds * 1000, vbat_mv, usb };
					controller.enqueue(encoder.encode(`${JSON.stringify(sample)}\n`));
				}, 1000 / SPEEDUP);
			},
			cancel: () => clearInterval(timer)
		})
	};
}
