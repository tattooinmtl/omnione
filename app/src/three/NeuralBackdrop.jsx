import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/* Slow-drifting blue neural constellation.
 * 220 points, connected by faint lines when within range.
 * Used as ambient backdrop for the splash and the app shell.
 */

const POINT_COUNT = 220;
const LINK_DISTANCE = 1.6;

function generatePoints() {
  const positions = new Float32Array(POINT_COUNT * 3);
  // Seeded pseudo-random for stable first frame.
  let s = 1337;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  for (let i = 0; i < POINT_COUNT; i++) {
    // Distribute on a thick spherical shell
    const r = 4 + rand() * 4;
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  return positions;
}

function buildLinkGeometry(positions) {
  // Build a list of line segments between points within LINK_DISTANCE.
  const segments = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    for (let j = i + 1; j < POINT_COUNT; j++) {
      const dx = positions[i * 3] - positions[j * 3];
      const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
      const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < LINK_DISTANCE * LINK_DISTANCE) {
        segments.push(
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
          positions[j * 3],
          positions[j * 3 + 1],
          positions[j * 3 + 2]
        );
      }
    }
  }
  return new Float32Array(segments);
}

function Constellation() {
  const groupRef = useRef();
  const pointsRef = useRef();

  const positions = useMemo(() => generatePoints(), []);
  const linkPositions = useMemo(() => buildLinkGeometry(positions), [positions]);

  useFrame((state, delta) => {
    if (groupRef.current) {
      // Slow drift rotation
      groupRef.current.rotation.y += delta * 0.05;
      groupRef.current.rotation.x += delta * 0.02;
    }
    if (pointsRef.current) {
      // Pulse the size very slightly
      const t = state.clock.elapsedTime;
      const s = 1 + Math.sin(t * 1.4) * 0.08;
      pointsRef.current.scale.set(s, s, s);
    }
  });

  return (
    <group ref={groupRef}>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={positions}
            count={POINT_COUNT}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial
          color="#5fa8ff"
          size={0.06}
          sizeAttenuation
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </points>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={linkPositions}
            count={linkPositions.length / 3}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial
          color="#2f7bff"
          transparent
          opacity={0.18}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}

export default function NeuralBackdrop({ cameraZ = 8 }) {
  return (
    <Canvas
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 1.6]}
      camera={{ position: [0, 0, cameraZ], fov: 55 }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        background: 'radial-gradient(ellipse at center, #050810 0%, #000000 70%)',
      }}
    >
      <ambientLight intensity={0.4} />
      <Constellation />
    </Canvas>
  );
}
