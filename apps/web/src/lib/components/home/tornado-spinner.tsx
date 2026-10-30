const RING_WIDTHS_PX = [16, 13, 10, 7, 5];

export function TornadoSpinner() {
	return (
		<span className="inline-flex flex-col items-center" aria-hidden="true">
			{RING_WIDTHS_PX.map((width, index) => (
				<span
					key={width}
					className="motion-safe:animate-tornado-sway -mt-px h-1 rounded-full border-[1.5px] border-[#8cc0e7] first:mt-0"
					style={{ width, animationDelay: `${-index * 140}ms` }}
				></span>
			))}
		</span>
	);
}
