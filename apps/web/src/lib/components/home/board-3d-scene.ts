import {
	Box3,
	type Material,
	Mesh,
	type Object3D,
	PerspectiveCamera,
	PMREMGenerator,
	Scene,
	Sphere,
	Texture,
	Vector3,
	WebGLRenderer
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type BoardScene = ReturnType<typeof createBoardScene>;

/** From above the board's front, tilted toward the viewer like KiCad's 3D viewer. */
const VIEW_DIRECTION = new Vector3(0, 1, 0.8).normalize();

function disposeTree(root: Object3D) {
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

export function createBoardScene(container: HTMLElement) {
	const renderer = new WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(devicePixelRatio);
	renderer.domElement.className = 'block size-full';
	container.append(renderer.domElement);

	const scene = new Scene();
	const pmrem = new PMREMGenerator(renderer);
	const room = new RoomEnvironment();
	// KiCad's glTF uses metallic materials, which reflect only an environment.
	scene.environment = pmrem.fromScene(room, 0.04).texture;
	room.dispose();
	pmrem.dispose();

	const camera = new PerspectiveCamera(35, 1);
	const controls = new OrbitControls(camera, renderer.domElement);
	let frame = 0;
	let board: Object3D | null = null;

	const render = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => renderer.render(scene, camera));
	};

	const fit = (root: Object3D) => {
		const bounds = new Box3().setFromObject(root).getBoundingSphere(new Sphere());
		const halfFov = (camera.fov * Math.PI) / 360;
		const narrowerHalfFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
		const distance = bounds.radius / Math.sin(narrowerHalfFov);

		camera.near = distance / 100;
		camera.far = distance * 100;
		camera.position.copy(bounds.center).addScaledVector(VIEW_DIRECTION, distance);
		camera.updateProjectionMatrix();
		controls.target.copy(bounds.center);
		controls.update();
	};

	const resize = new ResizeObserver(() => {
		const { clientWidth: width, clientHeight: height } = container;

		if (!width || !height) return;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		render();
	});

	controls.addEventListener('change', render);
	resize.observe(container);

	return {
		/** Swaps in a new export, keeping the camera after the first one so reloads don't reset it. */
		async show(glb: ArrayBuffer) {
			const { scene: next } = await new GLTFLoader().parseAsync(glb, '');

			if (board) {
				scene.remove(board);
				disposeTree(board);
			} else {
				fit(next);
			}

			board = next;
			scene.add(next);
			render();
		},
		dispose() {
			cancelAnimationFrame(frame);
			resize.disconnect();
			controls.dispose();

			if (board) disposeTree(board);
			scene.environment?.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		}
	};
}
