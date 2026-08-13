"use client";

import { Environment, Lightformer, MeshTransmissionMaterial, PerspectiveCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, SMAA } from "@react-three/postprocessing";
import { Leva, useControls } from "leva";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";

type FeatherStudy = {
	geometries: THREE.ExtrudeGeometry[];
	scale: number;
	size: THREE.Vector3;
};

type GlassSettings = {
	thickness: number;
	roughness: number;
	ior: number;
	chromaticAberration: number;
	distortion: number;
	distortionScale: number;
	temporalDistortion: number;
};

type FeatherInteraction = {
	dragging: boolean;
	previous: { x: number; y: number; time: number };
	pendingRotation: { yaw: number; pitch: number };
	velocity: { yaw: number; pitch: number };
};

const RESTING_ROTATION: [number, number, number] = [-0.05, -0.25, -0.025];
const MAX_PITCH = THREE.MathUtils.degToRad(26);

function useReducedMotion() {
	const [reducedMotion, setReducedMotion] = useState(false);

	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return reducedMotion;
}

function useFeatherGeometry() {
	const [study, setStudy] = useState<FeatherStudy | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		const geometries: THREE.ExtrudeGeometry[] = [];

		async function loadGeometry() {
			const response = await fetch("/robinhood.svg", { signal: controller.signal });
			if (!response.ok) {
				throw new Error(`Could not load the feather SVG (${response.status})`);
			}

			const svg = new SVGLoader().parse(await response.text());

			for (const path of svg.paths) {
				for (const shape of path.toShapes()) {
					const geometry = new THREE.ExtrudeGeometry(shape, {
						depth: 58,
						bevelEnabled: true,
						bevelThickness: 10,
						bevelSize: 9,
						bevelOffset: 0,
						bevelSegments: 5,
						curveSegments: 20,
						steps: 1,
					});
					geometry.computeVertexNormals();
					geometry.computeBoundingBox();
					geometries.push(geometry);
				}
			}

			const bounds = new THREE.Box3();
			for (const geometry of geometries) {
				if (geometry.boundingBox) bounds.union(geometry.boundingBox);
			}

			const center = bounds.getCenter(new THREE.Vector3());
			const size = bounds.getSize(new THREE.Vector3());
			const scale = 4.8 / Math.max(size.x, size.y);

			for (const geometry of geometries) {
				geometry.translate(-center.x, -center.y, -center.z);
			}

			setStudy({ geometries, scale, size: size.multiplyScalar(scale) });
		}

		loadGeometry().catch((error: unknown) => {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				console.error(error);
			}
		});

		return () => {
			controller.abort();
			geometries.forEach((geometry) => geometry.dispose());
		};
	}, []);

	return study;
}

function CameraRig({ objectSize }: { objectSize: THREE.Vector3 }) {
	const viewportSize = useThree((state) => state.size);
	const fov = 36;
	const aspect = viewportSize.width / viewportSize.height;
	const verticalFov = THREE.MathUtils.degToRad(fov);
	const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
	const isPortrait = aspect < 0.72;
	const verticalFill = 0.67;
	const horizontalFill = isPortrait ? 0.92 : 0.8;
	const heightDistance = objectSize.y / verticalFill / (2 * Math.tan(verticalFov / 2));
	const widthDistance = objectSize.x / horizontalFill / (2 * Math.tan(horizontalFov / 2));
	const distance = Math.max(heightDistance, widthDistance) + objectSize.z * 0.55;

	return <PerspectiveCamera makeDefault fov={fov} near={Math.max(0.05, distance - 12)} far={distance + 25} position={[0, 0, distance]} />;
}

function RefractableBackdrop() {
	const viewportSize = useThree((state) => state.size);
	const dpr = useThree((state) => state.viewport.dpr);
	const uniforms = useMemo(
		() => ({
			uResolution: {
				value: new THREE.Vector2(viewportSize.width * dpr, viewportSize.height * dpr),
			},
			uCenterColor: { value: new THREE.Color("#101a14") },
			uEdgeColor: { value: new THREE.Color("#030403") },
			uGreenGlow: { value: new THREE.Color("#123522") },
			uVioletGlow: { value: new THREE.Color("#17122b") },
		}),
		[dpr, viewportSize.height, viewportSize.width],
	);

	return (
		<mesh position={[0, 0, -6]} renderOrder={-1000} frustumCulled={false}>
			<planeGeometry args={[60, 60]} />
			<shaderMaterial
				uniforms={uniforms}
				depthWrite={false}
				toneMapped={false}
				vertexShader={`
          void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
				fragmentShader={`
          uniform vec2 uResolution;
          uniform vec3 uCenterColor;
          uniform vec3 uEdgeColor;
          uniform vec3 uGreenGlow;
          uniform vec3 uVioletGlow;

          void main() {
            vec2 uv = gl_FragCoord.xy / uResolution;
            vec2 centered = uv - 0.5;
            centered.x *= uResolution.x / uResolution.y;

            float radial = 1.0 - smoothstep(0.04, 0.78, length(centered));
            float green = 1.0 - smoothstep(0.0, 0.52, length(centered - vec2(0.12, 0.04)));
            float violet = 1.0 - smoothstep(0.0, 0.42, length(centered - vec2(-0.28, -0.16)));

            vec3 color = mix(uEdgeColor, uCenterColor, radial);
            color += uGreenGlow * green * 0.18;
            color += uVioletGlow * violet * 0.1;
            gl_FragColor = vec4(color, 1.0);
          }
        `}
			/>
		</mesh>
	);
}

function ReflectionEnvironment({ intensity }: { intensity: number }) {
	return (
		<>
			<Environment resolution={256} frames={1} environmentIntensity={1.15}>
				<Lightformer color="#eafff2" form="rect" intensity={4.8 * intensity} position={[0, 1, 7]} scale={[4, 5, 1]} target={[0, 0, 0]} />
				<Lightformer color="#00ff75" form="rect" intensity={5.5 * intensity} position={[5, 1, 2]} scale={[3, 7, 1]} target={[0, 0, 0]} />
				<Lightformer color="#55f4ff" form="rect" intensity={5 * intensity} position={[-2, 5, 2]} scale={[5, 2.5, 1]} target={[0, 0, 0]} />
				<Lightformer color="#4a70ff" form="rect" intensity={4.4 * intensity} position={[0, -5, 1]} scale={[5, 2.5, 1]} target={[0, 0, 0]} />
				<Lightformer color="#a45cff" form="rect" intensity={4.8 * intensity} position={[-5, -0.5, -2]} scale={[3, 6, 1]} target={[0, 0, 0]} />
				<Lightformer color="#ffffff" form="ring" intensity={2.2 * intensity} position={[0, 0, -7]} scale={4} target={[0, 0, 0]} />
			</Environment>

			<ambientLight intensity={0.08} />
			<directionalLight color="#dbfff0" intensity={1.4 * intensity} position={[3, 4, 6]} />
			<pointLight color="#00e86f" intensity={9 * intensity} position={[4, 0, 3]} distance={12} />
			<pointLight color="#776cff" intensity={7 * intensity} position={[-4, -1, 2]} distance={11} />
		</>
	);
}

function GlassMaterial({ settings }: { settings: GlassSettings }) {
	return (
		<MeshTransmissionMaterial
			transmissionSampler
			transmission={1}
			thickness={settings.thickness}
			roughness={settings.roughness}
			ior={settings.ior}
			chromaticAberration={settings.chromaticAberration}
			distortion={settings.distortion}
			distortionScale={settings.distortionScale}
			temporalDistortion={settings.temporalDistortion}
			anisotropicBlur={0.08}
			attenuationColor="#d5ffe5"
			attenuationDistance={3.8}
			clearcoat={1}
			clearcoatRoughness={0.08}
			envMapIntensity={1.45}
			color="#f1fff7"
			samples={6}
		/>
	);
}

function Feather({ study, glass, onFastMotionChange }: { study: FeatherStudy; glass: GlassSettings; onFastMotionChange: (fastMotion: boolean) => void }) {
	const floatGroup = useRef<THREE.Group>(null);
	const featherGroup = useRef<THREE.Group>(null);
	const interaction = useRef<FeatherInteraction>({
		dragging: false,
		previous: { x: 0, y: 0, time: 0 },
		pendingRotation: { yaw: 0, pitch: 0 },
		velocity: { yaw: 0, pitch: 0 },
	});
	const settleTimer = useRef<number | null>(null);
	const reducedMotion = useReducedMotion();

	useEffect(() => {
		const canvas = document.querySelector<HTMLCanvasElement>(".feather-stage canvas");
		if (!canvas) return;
		const stage = canvas.closest<HTMLElement>(".feather-stage");

		const clearSettleTimer = () => {
			if (settleTimer.current !== null) {
				window.clearTimeout(settleTimer.current);
				settleTimer.current = null;
			}
		};

		const startDrag = (event: PointerEvent) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;

			clearSettleTimer();
			interaction.current.dragging = true;
			interaction.current.previous = { x: event.clientX, y: event.clientY, time: event.timeStamp };
			interaction.current.pendingRotation = { yaw: 0, pitch: 0 };
			interaction.current.velocity = { yaw: 0, pitch: 0 };
			canvas.style.cursor = "grabbing";
			canvas.setPointerCapture(event.pointerId);
			stage?.focus({ preventScroll: true });
			onFastMotionChange(true);
		};

		const updateDrag = (event: PointerEvent) => {
			if (!interaction.current.dragging) return;

			const elapsed = Math.max((event.timeStamp - interaction.current.previous.time) / 1000, 1 / 120);
			const yawDelta = (event.clientX - interaction.current.previous.x) * 0.0075;
			const pitchDelta = (event.clientY - interaction.current.previous.y) * 0.0058;

			interaction.current.previous = { x: event.clientX, y: event.clientY, time: event.timeStamp };
			interaction.current.pendingRotation.yaw += yawDelta;
			interaction.current.pendingRotation.pitch += pitchDelta;
			interaction.current.velocity.yaw = THREE.MathUtils.clamp(THREE.MathUtils.lerp(interaction.current.velocity.yaw, yawDelta / elapsed, 0.34), -4.8, 4.8);
			interaction.current.velocity.pitch = THREE.MathUtils.clamp(THREE.MathUtils.lerp(interaction.current.velocity.pitch, pitchDelta / elapsed, 0.34), -2.2, 2.2);
		};

		const finishDrag = () => {
			if (!interaction.current.dragging) return;
			interaction.current.dragging = false;
			canvas.style.cursor = "grab";
			clearSettleTimer();
			settleTimer.current = window.setTimeout(() => onFastMotionChange(false), 700);
		};

		const endDrag = (event: PointerEvent) => {
			finishDrag();
			if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
		};

		const rotateWithKeyboard = (event: KeyboardEvent) => {
			if (event.key === "ArrowLeft") interaction.current.velocity.yaw -= 0.7;
			else if (event.key === "ArrowRight") interaction.current.velocity.yaw += 0.7;
			else if (event.key === "ArrowUp") interaction.current.velocity.pitch -= 0.45;
			else if (event.key === "ArrowDown") interaction.current.velocity.pitch += 0.45;
			else return;

			event.preventDefault();
		};

		canvas.style.cursor = "grab";
		canvas.addEventListener("pointerdown", startDrag);
		canvas.addEventListener("pointermove", updateDrag);
		canvas.addEventListener("pointerup", endDrag);
		canvas.addEventListener("pointercancel", endDrag);
		stage?.addEventListener("keydown", rotateWithKeyboard);

		return () => {
			clearSettleTimer();
			canvas.style.removeProperty("cursor");
			canvas.removeEventListener("pointerdown", startDrag);
			canvas.removeEventListener("pointermove", updateDrag);
			canvas.removeEventListener("pointerup", endDrag);
			canvas.removeEventListener("pointercancel", endDrag);
			stage?.removeEventListener("keydown", rotateWithKeyboard);
		};
	}, [onFastMotionChange]);

	useFrame((state, delta) => {
		if (!featherGroup.current || !floatGroup.current) return;

		const elapsed = state.clock.getElapsedTime();
		floatGroup.current.position.y = reducedMotion ? 0 : Math.sin(elapsed * 0.62) * 0.045;

		featherGroup.current.rotation.y += interaction.current.pendingRotation.yaw;
		featherGroup.current.rotation.x += interaction.current.pendingRotation.pitch;
		interaction.current.pendingRotation.yaw = 0;
		interaction.current.pendingRotation.pitch = 0;

		if (!interaction.current.dragging) {
			featherGroup.current.rotation.y += interaction.current.velocity.yaw * delta;
			featherGroup.current.rotation.x += interaction.current.velocity.pitch * delta;

			const damping = Math.exp(-2.65 * delta);
			interaction.current.velocity.yaw *= damping;
			interaction.current.velocity.pitch *= damping;

			const momentum = Math.abs(interaction.current.velocity.yaw) + Math.abs(interaction.current.velocity.pitch);
			if (!reducedMotion && momentum < 0.022) {
				featherGroup.current.rotation.y += delta * 0.055;
				featherGroup.current.rotation.z = RESTING_ROTATION[2] + Math.sin(elapsed * 0.38) * 0.007;
			}
		}

		featherGroup.current.rotation.x = THREE.MathUtils.clamp(featherGroup.current.rotation.x, -MAX_PITCH, MAX_PITCH);
	});

	return (
		<group ref={floatGroup}>
			<group ref={featherGroup} scale={[study.scale, -study.scale, study.scale]} rotation={RESTING_ROTATION}>
				{study.geometries.map((geometry, index) => (
					<mesh key={index} geometry={geometry} castShadow>
						<GlassMaterial settings={glass} />
					</mesh>
				))}
			</group>
		</group>
	);
}

function Scene({ glass, lightIntensity, onFastMotionChange }: { glass: GlassSettings; lightIntensity: number; onFastMotionChange: (fastMotion: boolean) => void }) {
	const study = useFeatherGeometry();

	return (
		<>
			<ReflectionEnvironment intensity={lightIntensity} />
			<RefractableBackdrop />
			{study ? (
				<>
					<CameraRig objectSize={study.size} />
					<Feather study={study} glass={glass} onFastMotionChange={onFastMotionChange} />
				</>
			) : null}
			<EffectComposer multisampling={0} enableNormalPass={false}>
				<Bloom intensity={0.16} luminanceThreshold={1.1} luminanceSmoothing={0.72} mipmapBlur />
				<SMAA />
			</EffectComposer>
		</>
	);
}

export default function FeatherExperience() {
	const [fastMotion, setFastMotion] = useState(false);
	const glass = useControls("Liquid glass", {
		thickness: { value: 1.25, min: 0, max: 5, step: 0.01 },
		roughness: { value: 0.075, min: 0, max: 0.5, step: 0.005 },
		ior: { value: 1.46, min: 1, max: 2.5, step: 0.01 },
		chromaticAberration: { value: 0.045, min: 0, max: 0.2, step: 0.005 },
		distortion: { value: 0.12, min: 0, max: 0.6, step: 0.01 },
		distortionScale: { value: 0.3, min: 0, max: 1, step: 0.01 },
		temporalDistortion: { value: 0.025, min: 0, max: 0.2, step: 0.005 },
	}) as GlassSettings;
	const { lightIntensity } = useControls("Environment", {
		lightIntensity: { value: 1, min: 0.2, max: 2.5, step: 0.05 },
	});

	return (
		<main className="feather-stage" aria-label="Interactive crystal Robinhood feather. Drag to spin it, or use the arrow keys." tabIndex={0}>
			<Canvas
				className="feather-canvas"
				dpr={fastMotion ? [1, 1.25] : [1, 2]}
				camera={{ position: [0, 0, 11], fov: 36, near: 0.1, far: 100 }}
				gl={{
					antialias: true,
					alpha: true,
					powerPreference: "high-performance",
					toneMapping: THREE.ACESFilmicToneMapping,
				}}
				onCreated={({ gl }) => gl.setClearColor("#050706", 0)}
				fallback={<div className="webgl-fallback">This sculpture needs WebGL to render.</div>}
			>
				<Scene glass={glass} lightIntensity={lightIntensity} onFastMotionChange={setFastMotion} />
			</Canvas>
			<p className="sr-only">Drag horizontally to rotate the feather. Drag vertically to tilt it.</p>
			<Leva hidden={process.env.NODE_ENV === "production"} collapsed />
		</main>
	);
}
