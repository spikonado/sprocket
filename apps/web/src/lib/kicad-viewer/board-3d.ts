import {
	AlwaysStencilFunc,
	BufferGeometry,
	Color,
	DoubleSide,
	EqualStencilFunc,
	Float32BufferAttribute,
	GLSL3,
	Group,
	InstancedBufferGeometry,
	InstancedInterleavedBuffer,
	InterleavedBuffer,
	InterleavedBufferAttribute,
	KeepStencilOp,
	type Material,
	Mesh,
	MeshStandardMaterial,
	type Object3D,
	PerspectiveCamera,
	Plane,
	PMREMGenerator,
	Ray,
	ReplaceStencilOp,
	Scene as ThreeScene,
	ShaderMaterial,
	Sphere,
	Spherical,
	SRGBColorSpace,
	Texture,
	Vector2,
	Vector3,
	WebGLRenderer
} from 'three';
import * as Three from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { wheelZoomFactor } from '$lib/kicad-viewer/camera';
import type {
	FromWorker,
	PointerInput,
	ViewportSize,
	WheelInput
} from '$lib/kicad-viewer/protocol';
import {
	CIRCLE_BYTES,
	SEGMENT_BYTES,
	VERTEX_BYTES,
	type ColorRgba,
	type Scene,
	type SceneLayer
} from '$lib/kicad-viewer/scene';

/** Heights above the outer copper, from KiCad's `STEP_PCB_MODEL::getLayerZPlacement`. */
const MASK_ABOVE_COPPER = 0.015;
const SILK_ABOVE_COPPER = 0.04;

const FOV = 35;
const VIEW_DIRECTION = new Vector3(0, 1, 0.8).normalize();
const ORBIT_PER_PX = 0.008;
const MIN_RADIUS = 0.5;
const WALL_SEGMENTS = 12;

/** Stencil bits: inside a drill hole, and inside a solder mask opening. */
const HOLE_BIT = 1;
const OPENING_BIT = 2;

type Role =
	| { kind: 'paint'; color: ColorRgba; clip: number }
	| { kind: 'mark'; bit: number }
	| { kind: 'glass'; color: ColorRgba; clip: number };

const SHARED_VERTEX = `
uniform float u_height;
uniform float u_pxPerDistance;

vec4 place(vec2 board) {
	return projectionMatrix * viewMatrix * vec4(board.x, u_height, board.y, 1.0);
}

float devicePx(vec2 board) {
	return length((viewMatrix * vec4(board.x, u_height, board.y, 1.0)).xyz) * u_pxPerDistance;
}
`;

const SHARED_FRAGMENT = `
uniform vec3 u_color;
uniform float u_opacity;
out vec4 outColor;

void cover(float distance) {
	float coverage = clamp(0.5 - distance / max(fwidth(distance), 1e-6), 0.0, 1.0);
	if (coverage <= 0.0) discard;
	outColor = vec4(u_color, u_opacity * coverage);
}
`;

/** The 2D viewer's segment and circle records, drawn flat at `u_height`. */
const SHADERS = {
	segments: {
		vertex: `${SHARED_VERTEX}
in vec4 a_line;
in float a_width;
out vec2 v_local;
out float v_length;
out float v_radius;

void main() {
	vec2 delta = a_line.zw - a_line.xy;
	float len = length(delta);
	vec2 along = len > 0.0 ? delta / len : vec2(1.0, 0.0);
	vec2 across = vec2(-along.y, along.x);
	float px = devicePx((a_line.xy + a_line.zw) * 0.5);
	float radius = max(a_width * 0.5, 0.5 * px);
	float reach = radius + px;
	v_local = vec2(mix(-reach, len + reach, position.x), mix(-reach, reach, position.y));
	v_length = len;
	v_radius = radius;
	gl_Position = place(a_line.xy + along * v_local.x + across * v_local.y);
}`,
		fragment: `${SHARED_FRAGMENT}
in vec2 v_local;
in float v_length;
in float v_radius;

void main() {
	cover(length(vec2(v_local.x - clamp(v_local.x, 0.0, v_length), v_local.y)) - v_radius);
}`
	},
	circles: {
		vertex: `${SHARED_VERTEX}
in vec4 a_circle;
out vec2 v_local;
out float v_radius;
out float v_half;

void main() {
	float px = devicePx(a_circle.xy);
	v_half = a_circle.w > 0.0 ? max(a_circle.w * 0.5, 0.5 * px) : 0.0;
	v_radius = a_circle.w > 0.0 ? a_circle.z : max(a_circle.z, 0.5 * px);
	float reach = v_radius + v_half + px;
	v_local = (position.xy * 2.0 - 1.0) * reach;
	gl_Position = place(a_circle.xy + v_local);
}`,
		fragment: `${SHARED_FRAGMENT}
in vec2 v_local;
in float v_radius;
in float v_half;

void main() {
	float d = length(v_local) - v_radius;
	cover(v_half > 0.0 ? abs(d) - v_half : d);
}`
	},
	triangles: {
		vertex: `${SHARED_VERTEX}
void main() {
	gl_Position = place(position.xy);
}`,
		fragment: `
uniform vec3 u_color;
uniform float u_opacity;
out vec4 outColor;

void main() {
	outColor = vec4(u_color, u_opacity);
}`
	}
};

/** Hole walls: a stadium around each segment, or a cylinder around each circle. */
const WALL_VERTEX = `
in vec2 a_start;
in vec2 a_end;
in float a_size;
uniform float u_radiusPerSize;
uniform float u_bottom;
uniform float u_top;
out vec3 v_normal;
out vec3 v_toCamera;

void main() {
	vec2 delta = a_end - a_start;
	float len = length(delta);
	vec2 along = len > 0.0 ? delta / len : vec2(1.0, 0.0);
	vec2 outward = cos(position.x) * along + sin(position.x) * vec2(-along.y, along.x);
	vec2 board = (position.y > 0.5 ? a_end : a_start) + outward * a_size * u_radiusPerSize;
	vec3 world = vec3(board.x, mix(u_bottom, u_top, position.z), board.y);
	v_normal = vec3(outward.x, 0.0, outward.y);
	v_toCamera = cameraPosition - world;
	gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const WALL_FRAGMENT = `
uniform vec3 u_color;
in vec3 v_normal;
in vec3 v_toCamera;
out vec4 outColor;

void main() {
	float facing = abs(dot(normalize(v_normal), normalize(v_toCamera)));
	outColor = vec4(u_color * (0.35 + 0.65 * facing), 1.0);
}`;

const QUAD = (() => {
	const geometry = new BufferGeometry();
	geometry.setAttribute(
		'position',
		new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3)
	);
	geometry.setIndex([0, 1, 2, 2, 1, 3]);

	return geometry;
})();

const WALL = (() => {
	const ring: number[] = [];

	for (const end of [1, 0]) {
		for (let step = 0; step <= WALL_SEGMENTS; step++) {
			ring.push(Math.PI * (step / WALL_SEGMENTS + (end ? -0.5 : 0.5)), end);
		}
	}

	const count = ring.length / 2;
	const positions: number[] = [];
	const index: number[] = [];

	for (const level of [0, 1]) {
		for (let point = 0; point < count; point++) {
			positions.push(ring[point * 2], ring[point * 2 + 1], level);
		}
	}

	for (let point = 0; point < count; point++) {
		const next = (point + 1) % count;
		index.push(point, next, point + count, point + count, next, next + count);
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	geometry.setIndex(index);

	return geometry;
})();

type Uniforms = { u_pxPerDistance: { value: number } };

/**
 * Stencil masks avoid triangulating thousands of drill holes and solder mask openings
 * into the board outline.
 */
export class Board3d {
	private readonly renderer: WebGLRenderer;
	private readonly world = new ThreeScene();
	private readonly camera = new PerspectiveCamera(FOV, 1);
	private readonly uniforms: Uniforms = { u_pxPerDistance: { value: 0 } };
	private readonly orbit = { target: new Vector3(), spherical: new Spherical() };
	private readonly pointers = new Map<number, { x: number; y: number }>();
	private drag: 'orbit' | 'pan' = 'orbit';
	private pinchDistance = 0;
	private size: ViewportSize;
	private board: { group: Group; front: Group; back: Group; top: number; bottom: number } | null =
		null;
	private models: Object3D | null = null;
	private modelsLoad = 0;
	private componentsVisible = true;
	private bounds: { center: Vector3; radius: number } | null = null;
	private placed = false;
	private flipped = false;
	private shown = false;
	private frameRequested = false;

	constructor(
		canvas: OffscreenCanvas,
		viewport: ViewportSize,
		private readonly post: (message: FromWorker) => void
	) {
		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true });
		this.size = viewport;

		const pmrem = new PMREMGenerator(this.renderer);
		const room = new RoomEnvironment();
		// KiCad's glTF uses metallic materials, which reflect only an environment.
		this.world.environment = pmrem.fromScene(room, 0.04).texture;
		room.dispose();
		pmrem.dispose();

		this.resize(viewport);
	}

	setShown(shown: boolean) {
		this.shown = shown;
		this.requestFrame();
	}

	setScene(scene: Scene) {
		if (this.board) {
			this.world.remove(this.board.group);
			dispose(this.board.group);
		}

		this.board = buildBoard(scene, this.uniforms);
		this.world.add(this.board.group);

		const [minX, minY, maxX, maxY] = scene.meta.bounds;
		const { top, bottom } = this.board;
		const corner = new Vector3(maxX - minX, top - bottom, maxY - minY);
		this.bounds = {
			center: new Vector3((minX + maxX) / 2, (top + bottom) / 2, (minY + maxY) / 2),
			radius: Math.max(corner.length() / 2, 1)
		};

		this.requestFrame();
	}

	/** Shows KiCad's GLB of the component models, or none for an empty buffer. */
	async setModels(glb: ArrayBuffer) {
		const load = ++this.modelsLoad;

		try {
			const next = glb.byteLength > 0 ? (await new GLTFLoader().parseAsync(glb, '')).scene : null;

			if (load !== this.modelsLoad) {
				if (next) dispose(next);

				return;
			}

			if (this.models) {
				this.world.remove(this.models);
				dispose(this.models);
			}

			this.models = next;

			if (next) {
				// KiCad exports meters in glTF's frame, which is this view's frame in mm.
				next.scale.setScalar(1000);
				next.visible = this.componentsVisible;
				this.world.add(next);
			}

			this.post({ type: 'models', error: null });
			this.requestFrame();
		} catch (error) {
			if (load !== this.modelsLoad) return;
			this.post({
				type: 'models',
				error: error instanceof Error ? error.message : 'Could not read the component models.'
			});
		}
	}

	setComponentsVisible(visible: boolean) {
		this.componentsVisible = visible;

		if (this.models) this.models.visible = visible;
		this.requestFrame();
	}

	resize(viewport: ViewportSize) {
		this.size = viewport;

		// A hidden viewer reports zero. Keeping the old size avoids a blank frame on return.
		if (!this.hasSize()) return;
		this.renderer.setPixelRatio(viewport.dpr);
		this.renderer.setSize(viewport.width, viewport.height, false);
		this.camera.aspect = viewport.width / viewport.height;
		this.requestFrame();
	}

	fit() {
		this.placed = false;
		this.requestFrame();
	}

	/** Turns the board over, keeping how far the camera is tilted. */
	flip(flipped: boolean) {
		if (flipped === this.flipped) return;
		this.flipped = flipped;

		const { spherical } = this.orbit;
		spherical.phi = Math.PI - spherical.phi;
		spherical.theta += Math.PI;
		this.requestFrame();
	}

	pointer({ phase, id, x, y, button, shift }: PointerInput) {
		const previous = this.pointers.get(id);

		if (phase === 'down') {
			this.pointers.set(id, { x, y });

			if (this.pointers.size === 1) this.drag = button === 0 && !shift ? 'orbit' : 'pan';
			else this.pinchDistance = this.pinch().distance;

			return;
		}

		if (!previous) return;

		if (phase !== 'move') {
			this.pointers.delete(id);

			if (this.pointers.size > 1) this.pinchDistance = this.pinch().distance;

			return;
		}

		const before = this.pinch();
		this.pointers.set(id, { x, y });

		if (!this.place()) return;

		if (this.pointers.size === 1) {
			if (this.drag === 'orbit') this.rotate(x - previous.x, y - previous.y);
			else this.pan(x - previous.x, y - previous.y);
		} else {
			const after = this.pinch();
			this.pan(after.x - before.x, after.y - before.y);

			if (this.pinchDistance > 0) this.zoom(this.pinchDistance / after.distance, after.x, after.y);
			this.pinchDistance = after.distance;
		}

		this.requestFrame();
	}

	wheel(input: WheelInput) {
		if (!this.place()) return;

		this.zoom(wheelZoomFactor(input, this.size.height), input.x, input.y);
		this.requestFrame();
	}

	private hasSize() {
		return this.size.width > 0 && this.size.height > 0;
	}

	/** Fits the camera to the board the first time it can, since a hidden panel has no size. */
	private place() {
		if (this.placed) return true;

		if (!this.bounds || !this.hasSize()) return false;

		const halfFov = (FOV * Math.PI) / 360;
		const aspect = this.size.width / this.size.height;
		const narrowerHalfFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect));
		const direction = VIEW_DIRECTION.clone();

		if (this.flipped) direction.y = -direction.y;
		this.orbit.target.copy(this.bounds.center);
		this.orbit.spherical.setFromVector3(direction);
		this.orbit.spherical.radius = (this.bounds.radius / Math.sin(narrowerHalfFov)) * 1.05;
		this.placed = true;

		return true;
	}

	private rotate(dx: number, dy: number) {
		const { spherical } = this.orbit;
		spherical.theta -= dx * ORBIT_PER_PX;
		spherical.phi = Math.min(Math.max(spherical.phi - dy * ORBIT_PER_PX, 1e-3), Math.PI - 1e-3);
	}

	/** Moves the target so the point under the cursor follows it. */
	private pan(dx: number, dy: number) {
		this.updateCamera();
		const perPx = this.mmPerPx(this.orbit.spherical.radius);
		const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
		const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);
		this.orbit.target.addScaledVector(right, -dx * perPx).addScaledVector(up, dy * perPx);
	}

	/** Scales the camera distance by `factor`, keeping the board point under the cursor in place. */
	private zoom(factor: number, x: number, y: number) {
		const { target, spherical } = this.orbit;
		const radius = Math.min(Math.max(spherical.radius * factor, MIN_RADIUS), this.maxRadius());
		const toward = this.boardPoint(x, y);

		if (toward) target.lerp(toward, 1 - radius / spherical.radius);
		spherical.radius = radius;
	}

	private maxRadius() {
		return (this.bounds?.radius ?? 100) * 20;
	}

	/** Where the cursor's ray meets the board's middle plane. */
	private boardPoint(x: number, y: number) {
		this.updateCamera();

		const ndc = new Vector3((x / this.size.width) * 2 - 1, 1 - (y / this.size.height) * 2, 0.5);
		const direction = ndc.unproject(this.camera).sub(this.camera.position).normalize();
		const middle = this.bounds?.center.y ?? 0;

		return new Ray(this.camera.position, direction).intersectPlane(
			new Plane(new Vector3(0, 1, 0), -middle),
			new Vector3()
		);
	}

	private mmPerPx(distance: number) {
		return (2 * distance * Math.tan((FOV * Math.PI) / 360)) / this.size.height;
	}

	private pinch() {
		const [a, b] = [...this.pointers.values()];

		if (!a || !b) return { x: a?.x ?? 0, y: a?.y ?? 0, distance: 0 };

		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
	}

	private updateCamera() {
		const { camera } = this;
		const { target, spherical } = this.orbit;

		camera.position.setFromSpherical(spherical).add(target);
		camera.near = spherical.radius / 100;
		camera.far = spherical.radius + this.maxRadius() * 2;
		camera.lookAt(target);
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
	}

	private requestFrame() {
		if (this.frameRequested) return;
		this.frameRequested = true;

		if ('requestAnimationFrame' in self) self.requestAnimationFrame(() => this.draw());
		else setTimeout(() => this.draw(), 16);
	}

	private draw() {
		this.frameRequested = false;

		if (!this.shown || !this.board || !this.place()) return;
		this.updateCamera();

		// One side's layers show at a time, which lets both sides share the stencil bits.
		const { front, back, top, bottom } = this.board;
		const height = this.camera.position.y;
		front.visible = height > top;
		back.visible = height < bottom;

		this.uniforms.u_pxPerDistance.value =
			(2 * Math.tan((FOV * Math.PI) / 360)) / (this.size.height * this.size.dpr);
		this.renderer.render(this.world, this.camera);
	}
}

function buildBoard(scene: Scene, uniforms: Uniforms) {
	const { board } = scene.meta;
	const { body, colors } = board;
	const [frontCopper, backCopper] = board.copper;
	const group = new Group();
	const front = new Group();
	const back = new Group();
	const outline = outlineGeometry(board.outlines);

	const holes = scene.layers.filter(
		(layer) =>
			layer.kind === 'holes' &&
			(layer.part === 'padHoles' || layer.part === 'viaHoles' || layer.part === 'npth')
	);

	const walls = new Mesh(
		outline.walls,
		new MeshStandardMaterial({
			color: new Color().setRGB(...rgbParts(colors.body), SRGBColorSpace),
			roughness: 0.8,
			side: DoubleSide
		})
	);

	walls.scale.y = body;
	group.add(walls, front, back);

	for (const hole of holes) {
		const plated = hole.part !== 'npth';
		group.add(
			...holeWalls(
				scene,
				hole,
				plated ? colors.finish : darker(colors.body),
				plated ? -backCopper : 0,
				plated ? body + frontCopper : body
			)
		);
	}

	for (const side of ['front', 'back'] as const) {
		const into = side === 'front' ? front : back;
		const sign = side === 'front' ? 1 : -1;
		const surface = side === 'front' ? body : 0;
		const copper = side === 'front' ? body + frontCopper : -backCopper;
		const mask = copper + sign * MASK_ABOVE_COPPER;
		const silk = copper + sign * SILK_ABOVE_COPPER;

		const onSide = (kind: SceneLayer['kind']) =>
			scene.layers.filter((layer) => layer.kind === kind && layer.side === side);

		const add = (layers: SceneLayer[], height: number, role: Role, order: number) => {
			for (const layer of layers) {
				into.add(...flatMeshes(scene, layer, height, role, order, uniforms));
			}
		};

		add(holes, copper, { kind: 'mark', bit: HOLE_BIT }, -2);
		add(onSide('mask'), mask, { kind: 'mark', bit: OPENING_BIT }, -1);
		into.add(
			flatMesh(
				outline.cap,
				'triangles',
				surface,
				{ kind: 'paint', color: colors.body, clip: HOLE_BIT },
				0,
				uniforms
			)
		);
		add(onSide('copper'), copper, { kind: 'paint', color: colors.finish, clip: HOLE_BIT }, 0);
		add(
			onSide('silk'),
			silk,
			{
				kind: 'paint',
				color: side === 'front' ? colors.silkFront : colors.silkBack,
				clip: HOLE_BIT | OPENING_BIT
			},
			1
		);
		into.add(
			flatMesh(
				outline.cap,
				'triangles',
				mask,
				{
					kind: 'glass',
					color: side === 'front' ? colors.maskFront : colors.maskBack,
					clip: HOLE_BIT | OPENING_BIT
				},
				2,
				uniforms
			)
		);
	}

	return { group, front, back, top: body, bottom: 0 };
}

/** The outline's face as triangles in board mm, and its side walls one mm tall. */
function outlineGeometry(outlines: Scene['meta']['board']['outlines']) {
	const cap: number[] = [];
	const positions: number[] = [];
	const normals: number[] = [];

	for (const { outer, holes } of outlines) {
		const contour = toVectors(outer);
		const cutouts = holes.map(toVectors);
		const triangles = Three.ShapeUtils.triangulateShape(contour, cutouts);
		const points = [contour, ...cutouts].flat();

		for (const triangle of triangles) {
			for (const corner of triangle) cap.push(points[corner].x, points[corner].y, 0);
		}

		for (const ring of [contour, ...cutouts]) {
			ring.forEach((a, index) => {
				const b = ring[(index + 1) % ring.length];
				const nx = b.y - a.y;
				const nz = a.x - b.x;
				const length = Math.hypot(nx, nz) || 1;

				for (const [x, y, z] of [
					[a.x, 0, a.y],
					[b.x, 0, b.y],
					[a.x, 1, a.y],
					[a.x, 1, a.y],
					[b.x, 0, b.y],
					[b.x, 1, b.y]
				]) {
					positions.push(x, y, z);
					normals.push(nx / length, 0, nz / length);
				}
			});
		}
	}

	const capGeometry = new BufferGeometry();
	capGeometry.setAttribute('position', new Float32BufferAttribute(cap, 3));

	const walls = new BufferGeometry();
	walls.setAttribute('position', new Float32BufferAttribute(positions, 3));
	walls.setAttribute('normal', new Float32BufferAttribute(normals, 3));

	return { cap: capGeometry, walls };
}

function toVectors(ring: number[]) {
	const points: Vector2[] = [];

	for (let index = 0; index + 1 < ring.length; index += 2) {
		points.push(new Vector2(ring[index], ring[index + 1]));
	}

	return points;
}

function flatMeshes(
	scene: Scene,
	layer: SceneLayer,
	height: number,
	role: Role,
	order: number,
	uniforms: Uniforms
) {
	const meshes: Mesh[] = [];

	if (layer.segments > 0) {
		const records = layerRecords(scene, layer.segmentOffset, layer.segments, SEGMENT_BYTES);
		const geometry = instanced(layer.segments);
		geometry.setAttribute('a_line', new InterleavedBufferAttribute(records, 4, 0));
		geometry.setAttribute('a_width', new InterleavedBufferAttribute(records, 1, 4));
		meshes.push(flatMesh(geometry, 'segments', height, role, order, uniforms));
	}

	if (layer.circles > 0) {
		const records = layerRecords(scene, layer.circleOffset, layer.circles, CIRCLE_BYTES);
		const geometry = instanced(layer.circles);
		geometry.setAttribute('a_circle', new InterleavedBufferAttribute(records, 4, 0));
		meshes.push(flatMesh(geometry, 'circles', height, role, order, uniforms));
	}

	if (layer.triangleVertices > 0) {
		const records = new InterleavedBuffer(
			new Float32Array(
				scene.buffer,
				layer.triangleOffset,
				(layer.triangleVertices * VERTEX_BYTES) / 4
			),
			VERTEX_BYTES / 4
		);

		const geometry = new BufferGeometry();
		geometry.setAttribute('position', new InterleavedBufferAttribute(records, 2, 0));
		meshes.push(flatMesh(geometry, 'triangles', height, role, order, uniforms));
	}

	return meshes;
}

function instanced(count: number) {
	const geometry = new InstancedBufferGeometry();
	geometry.index = QUAD.index;
	geometry.setAttribute('position', QUAD.getAttribute('position'));
	geometry.instanceCount = count;

	return geometry;
}

function flatMesh(
	geometry: BufferGeometry,
	primitive: keyof typeof SHADERS,
	height: number,
	role: Role,
	order: number,
	uniforms: Uniforms
) {
	const color: ColorRgba = role.kind === 'mark' ? [0, 0, 0, 1] : role.color;

	const material = new ShaderMaterial({
		glslVersion: GLSL3,
		vertexShader: SHADERS[primitive].vertex,
		fragmentShader: SHADERS[primitive].fragment,
		uniforms: {
			...uniforms,
			u_height: { value: height },
			u_color: { value: rgb(color) },
			u_opacity: { value: role.kind === 'glass' ? color[3] : 1 }
		},
		side: DoubleSide,
		transparent: role.kind === 'glass',
		depthWrite: role.kind === 'paint',
		alphaToCoverage: role.kind !== 'glass'
	});

	material.stencilWrite = true;

	if (role.kind === 'mark') {
		material.colorWrite = false;
		material.depthTest = false;
		material.stencilRef = role.bit;
		material.stencilWriteMask = role.bit;
		material.stencilFunc = AlwaysStencilFunc;
		material.stencilZPass = ReplaceStencilOp;
	} else {
		material.stencilRef = 0;
		material.stencilFuncMask = role.clip;
		material.stencilWriteMask = 0;
		material.stencilFunc = EqualStencilFunc;
		material.stencilZPass = KeepStencilOp;
	}

	const mesh = new Mesh(geometry, material);
	geometry.boundingSphere = UNBOUNDED;
	mesh.frustumCulled = false;
	mesh.renderOrder = order;

	return mesh;
}

/** Plated walls span both outer coppers, unplated ones only the body. */
function holeWalls(scene: Scene, layer: SceneLayer, color: ColorRgba, bottom: number, top: number) {
	const meshes: Mesh[] = [];

	const add = (
		records: InstancedInterleavedBuffer,
		count: number,
		end: number,
		size: number,
		radiusPerSize: number
	) => {
		const geometry = new InstancedBufferGeometry();
		geometry.index = WALL.index;
		geometry.setAttribute('position', WALL.getAttribute('position'));
		geometry.setAttribute('a_start', new InterleavedBufferAttribute(records, 2, 0));
		geometry.setAttribute('a_end', new InterleavedBufferAttribute(records, 2, end));
		geometry.setAttribute('a_size', new InterleavedBufferAttribute(records, 1, size));
		geometry.instanceCount = count;

		const mesh = new Mesh(
			geometry,
			new ShaderMaterial({
				glslVersion: GLSL3,
				vertexShader: WALL_VERTEX,
				fragmentShader: WALL_FRAGMENT,
				uniforms: {
					u_color: { value: rgb(color) },
					u_radiusPerSize: { value: radiusPerSize },
					u_bottom: { value: bottom },
					u_top: { value: top }
				},
				side: DoubleSide
			})
		);

		geometry.boundingSphere = UNBOUNDED;
		mesh.frustumCulled = false;
		meshes.push(mesh);
	};

	if (layer.segments > 0) {
		const records = layerRecords(scene, layer.segmentOffset, layer.segments, SEGMENT_BYTES);
		add(records, layer.segments, 2, 4, 0.5);
	}

	if (layer.circles > 0) {
		const records = layerRecords(scene, layer.circleOffset, layer.circles, CIRCLE_BYTES);
		add(records, layer.circles, 0, 2, 1);
	}

	return meshes;
}

function layerRecords(scene: Scene, offset: number, count: number, bytes: number) {
	return new InstancedInterleavedBuffer(
		new Float32Array(scene.buffer, offset, (count * bytes) / 4),
		bytes / 4
	);
}

function rgbParts([r, g, b]: ColorRgba): [number, number, number] {
	return [r, g, b];
}

/** Shader colors skip three's color management, so they stay in sRGB like KiCad's. */
function rgb(color: ColorRgba) {
	return new Vector3(...rgbParts(color));
}

/** Instanced layers have no meaningful bounds, and three only sorts by their center. */
const UNBOUNDED = new Sphere(new Vector3(), Infinity);

function darker([r, g, b, a]: ColorRgba): ColorRgba {
	return [r * 0.6, g * 0.6, b * 0.6, a];
}

function dispose(root: Object3D) {
	root.traverse((node) => {
		if (!(node instanceof Mesh)) return;

		node.geometry.dispose();

		const materials: Material[] = [node.material].flat();

		for (const material of materials) {
			for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
			material.dispose();
		}
	});
}
