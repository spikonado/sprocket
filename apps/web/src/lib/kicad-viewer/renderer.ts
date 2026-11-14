import { BACKGROUND, SELECTION, type Rgba } from '$lib/kicad-viewer/colors';
import { CIRCLE_BYTES, SEGMENT_BYTES, VERTEX_BYTES, type Scene } from '$lib/kicad-viewer/scene';

/** Segments thinner than `minWidthPx` device pixels are skipped, as KiCad hides small text. */
export type DrawLayer = { index: number; color: Rgba; minWidthPx: number };

export type Frame = {
	scale: readonly number[];
	offset: readonly number[];
	/** Device pixels per mm. */
	pxPerMm: number;
	/** Bottom to top. */
	layers: DrawLayer[];
	/** Drawn after the selection, so holes stay open and labels readable in selected pads. */
	overlays: DrawLayer[];
	selection: boolean;
};

const HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_pxPerMm;
uniform float u_minWidthPx;
uniform highp sampler2D u_flags;
uniform uint u_flagsWidth;
uniform bool u_selectedOnly;

bool culled(uint item) {
	if (!u_selectedOnly) return false;
	ivec2 texel = ivec2(int(item % u_flagsWidth), int(item / u_flagsWidth));
	return texelFetch(u_flags, texel, 0).r == 0.0;
}

vec4 clip(vec2 board) {
	return vec4(board * u_scale + u_offset, 0.0, 1.0);
}

const vec4 HIDDEN = vec4(2.0, 2.0, 2.0, 1.0);
`;

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_pxPerMm;
out vec4 color;

// Alpha only feeds alpha-to-coverage. Blending uses the layer's constant alpha.
void cover(float distancePx) {
	float coverage = clamp(0.5 - distancePx, 0.0, 1.0);
	if (coverage <= 0.0) discard;
	color = vec4(u_color, coverage);
}
`;

const SEGMENT_VERTEX = `${HEADER}
in vec4 a_line;
in float a_width;
in uint a_item;
out vec2 v_local;
out float v_length;
out float v_radius;

void main() {
	if (culled(a_item) || a_width * u_pxPerMm < u_minWidthPx) { gl_Position = HIDDEN; return; }
	vec2 delta = a_line.zw - a_line.xy;
	float len = length(delta);
	vec2 along = len > 0.0 ? delta / len : vec2(1.0, 0.0);
	vec2 across = vec2(-along.y, along.x);
	float px = 1.0 / u_pxPerMm;
	float radius = max(a_width * 0.5, 0.5 * px);
	float reach = radius + px;
	vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
	v_local = vec2(mix(-reach, len + reach, corner.x), mix(-reach, reach, corner.y));
	v_length = len;
	v_radius = radius;
	gl_Position = clip(a_line.xy + along * v_local.x + across * v_local.y);
}
`;

const SEGMENT_FRAGMENT = `${FRAGMENT_HEADER}
in vec2 v_local;
in float v_length;
in float v_radius;

void main() {
	vec2 nearest = vec2(v_local.x - clamp(v_local.x, 0.0, v_length), v_local.y);
	cover((length(nearest) - v_radius) * u_pxPerMm);
}
`;

const CIRCLE_VERTEX = `${HEADER}
in vec4 a_circle;
in uint a_item;
out vec2 v_local;
out float v_radius;
out float v_half;

void main() {
	if (culled(a_item)) { gl_Position = HIDDEN; return; }
	float px = 1.0 / u_pxPerMm;
	v_half = a_circle.w > 0.0 ? max(a_circle.w * 0.5, 0.5 * px) : 0.0;
	v_radius = a_circle.w > 0.0 ? a_circle.z : max(a_circle.z, 0.5 * px);
	float reach = v_radius + v_half + px;
	vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
	v_local = corner * reach;
	gl_Position = clip(a_circle.xy + v_local);
}
`;

const CIRCLE_FRAGMENT = `${FRAGMENT_HEADER}
in vec2 v_local;
in float v_radius;
in float v_half;

void main() {
	float d = length(v_local) - v_radius;
	cover((v_half > 0.0 ? abs(d) - v_half : d) * u_pxPerMm);
}
`;

const TRIANGLE_VERTEX = `${HEADER}
in vec2 a_position;
in uint a_item;

void main() {
	gl_Position = culled(a_item) ? HIDDEN : clip(a_position);
}
`;

const TRIANGLE_FRAGMENT = `${FRAGMENT_HEADER}
void main() {
	color = vec4(u_color, 1.0);
}
`;

type Program = {
	program: WebGLProgram;
	vao: WebGLVertexArrayObject;
	uniforms: Record<string, WebGLUniformLocation | null>;
	attributes: Record<string, number>;
};

const UNIFORMS = [
	'u_scale',
	'u_offset',
	'u_pxPerMm',
	'u_minWidthPx',
	'u_flags',
	'u_flagsWidth',
	'u_selectedOnly',
	'u_color'
];

/** Draws one scene. Recreate it after a lost context. */
export class BoardRenderer {
	private readonly segments: Program;
	private readonly circles: Program;
	private readonly triangles: Program;
	private readonly geometry: WebGLBuffer;
	private readonly flags: WebGLTexture;
	private readonly flagsWidth: number;
	private readonly flagsHeight: number;

	constructor(
		private readonly gl: WebGL2RenderingContext,
		private readonly scene: Scene
	) {
		this.segments = createProgram(gl, SEGMENT_VERTEX, SEGMENT_FRAGMENT, [
			'a_line',
			'a_width',
			'a_item'
		]);
		this.circles = createProgram(gl, CIRCLE_VERTEX, CIRCLE_FRAGMENT, ['a_circle', 'a_item']);
		this.triangles = createProgram(gl, TRIANGLE_VERTEX, TRIANGLE_FRAGMENT, [
			'a_position',
			'a_item'
		]);

		this.geometry = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.geometry);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Uint8Array(scene.buffer, scene.geometryOffset, scene.geometryBytes),
			gl.STATIC_DRAW
		);

		const items = Math.max(scene.meta.items.length, 1);
		const maxTextureSize: number = gl.getParameter(gl.MAX_TEXTURE_SIZE);

		this.flagsWidth = Math.min(items, maxTextureSize);
		this.flagsHeight = Math.ceil(items / this.flagsWidth);
		this.flags = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.flags);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, this.flagsWidth, this.flagsHeight);
		this.setFlags(new Uint8Array(scene.meta.items.length));
	}

	/** One byte per item. Nonzero items draw in the selection overlay. */
	setFlags(flags: Uint8Array) {
		const { gl } = this;
		const texels = new Uint8Array(this.flagsWidth * this.flagsHeight);
		texels.set(flags);
		gl.bindTexture(gl.TEXTURE_2D, this.flags);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(
			gl.TEXTURE_2D,
			0,
			0,
			0,
			this.flagsWidth,
			this.flagsHeight,
			gl.RED,
			gl.UNSIGNED_BYTE,
			texels
		);
	}

	draw(frame: Frame) {
		const { gl } = this;
		const [r, g, b] = BACKGROUND;

		gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
		gl.clearColor(r / 255, g / 255, b / 255, 1);
		gl.clearStencil(0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
		gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
		gl.enable(gl.STENCIL_TEST);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.flags);

		let stencil = 0;

		// Each pass tags the samples it covers, so overlapping primitives blend only once.
		const pass = (layers: DrawLayer[], color: Rgba, selectedOnly: boolean) => {
			if (stencil === 255) {
				gl.clear(gl.STENCIL_BUFFER_BIT);
				stencil = 0;
			}

			stencil++;
			gl.stencilFunc(gl.NOTEQUAL, stencil, 0xff);
			gl.blendColor(0, 0, 0, color[3]);

			for (const layer of layers) this.drawLayer(frame, layer, color, selectedOnly);
		};

		for (const layer of frame.layers) pass([layer], layer.color, false);

		if (frame.selection) pass(frame.layers, SELECTION, true);

		for (const layer of frame.overlays) pass([layer], layer.color, false);
	}

	dispose() {
		const { gl } = this;

		for (const { program, vao } of [this.segments, this.circles, this.triangles]) {
			gl.deleteProgram(program);
			gl.deleteVertexArray(vao);
		}

		gl.deleteBuffer(this.geometry);
		gl.deleteTexture(this.flags);
	}

	private drawLayer(frame: Frame, drawn: DrawLayer, color: Rgba, selectedOnly: boolean) {
		const { gl, scene } = this;
		const layer = scene.layers[drawn.index];
		const base = scene.geometryOffset;

		if (layer.segments > 0) {
			const { attributes: a, uniforms: u } = this.use(this.segments, frame, color, selectedOnly);
			gl.uniform1f(u.u_minWidthPx, drawn.minWidthPx);
			const offset = layer.segmentOffset - base;
			floatAttribute(gl, a.a_line, 4, SEGMENT_BYTES, offset, 1);
			floatAttribute(gl, a.a_width, 1, SEGMENT_BYTES, offset + 16, 1);
			itemAttribute(gl, a.a_item, SEGMENT_BYTES, offset + 20, 1);
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.segments);
		}

		if (layer.circles > 0) {
			const { attributes: a } = this.use(this.circles, frame, color, selectedOnly);
			const offset = layer.circleOffset - base;
			floatAttribute(gl, a.a_circle, 4, CIRCLE_BYTES, offset, 1);
			itemAttribute(gl, a.a_item, CIRCLE_BYTES, offset + 16, 1);
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.circles);
		}

		if (layer.triangleVertices > 0) {
			const { attributes: a } = this.use(this.triangles, frame, color, selectedOnly);
			const offset = layer.triangleOffset - base;
			floatAttribute(gl, a.a_position, 2, VERTEX_BYTES, offset, 0);
			itemAttribute(gl, a.a_item, VERTEX_BYTES, offset + 8, 0);
			gl.drawArrays(gl.TRIANGLES, 0, layer.triangleVertices);
		}
	}

	private use(program: Program, frame: Frame, color: Rgba, selectedOnly: boolean) {
		const { gl } = this;
		const { uniforms: u } = program;

		gl.useProgram(program.program);
		gl.bindVertexArray(program.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.geometry);
		gl.uniform2f(u.u_scale, frame.scale[0], frame.scale[1]);
		gl.uniform2f(u.u_offset, frame.offset[0], frame.offset[1]);
		gl.uniform1f(u.u_pxPerMm, frame.pxPerMm);
		gl.uniform1i(u.u_flags, 0);
		gl.uniform1ui(u.u_flagsWidth, this.flagsWidth);
		gl.uniform1i(u.u_selectedOnly, selectedOnly ? 1 : 0);
		gl.uniform3f(u.u_color, color[0] / 255, color[1] / 255, color[2] / 255);

		return program;
	}
}

function floatAttribute(
	gl: WebGL2RenderingContext,
	location: number,
	size: number,
	stride: number,
	offset: number,
	divisor: number
) {
	gl.enableVertexAttribArray(location);
	gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
	gl.vertexAttribDivisor(location, divisor);
}

function itemAttribute(
	gl: WebGL2RenderingContext,
	location: number,
	stride: number,
	offset: number,
	divisor: number
) {
	gl.enableVertexAttribArray(location);
	gl.vertexAttribIPointer(location, 1, gl.UNSIGNED_INT, stride, offset);
	gl.vertexAttribDivisor(location, divisor);
}

function createProgram(
	gl: WebGL2RenderingContext,
	vertexSource: string,
	fragmentSource: string,
	attributeNames: string[]
): Program {
	const program = gl.createProgram();

	for (const [type, source] of [
		[gl.VERTEX_SHADER, vertexSource],
		[gl.FRAGMENT_SHADER, fragmentSource]
	] as const) {
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);

		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
			throw new Error(`Could not build the board shaders: ${gl.getShaderInfoLog(shader)}`);
		}

		gl.attachShader(program, shader);
		gl.deleteShader(shader);
	}

	gl.linkProgram(program);

	if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
		throw new Error(`Could not build the board shaders: ${gl.getProgramInfoLog(program)}`);
	}

	return {
		program,
		vao: gl.createVertexArray(),
		uniforms: Object.fromEntries(
			UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])
		),
		attributes: Object.fromEntries(
			attributeNames.map((name) => [name, gl.getAttribLocation(program, name)])
		)
	};
}
