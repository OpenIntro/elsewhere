/**
 * CHARACTER CONTRACT — owned by the characters worker.
 *
 * <Character> renders a collectible-designer-toy character at its local origin
 * (feet at y=0, facing +Z). The parent positions/rotates it every frame (refs,
 * not props), so these props only change on low-frequency events and React
 * re-renders stay cheap. All per-frame animation runs in one useFrame.
 *
 * Rendering: ONE rigid-skinned mesh per character (1 draw call, +1 in the
 * shadow pass; +1 while holding an item, +1 for the NPC marker). Geometry is
 * cached and shared between characters with identical appearance; the toy
 * materials are shared by everybody.
 *
 * Sitting: with anim 'sit' the root is assumed to be at the seat surface (see
 * ARCHITECTURE: seated root = seat.position at groundHeight + seat.height).
 * Pass sitStyle="ground" when the root is on the ground instead.
 */
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import { Bone, Mesh, Object3D, OctahedronGeometry, Skeleton, SkinnedMesh, Sphere, Vector3 } from 'three';
import type { AnimState, Appearance, ItemId } from '@elsewhere/shared';
import { Animator } from './animation.js';
import { getCharacter, releaseCharacter, retainCharacter } from './cache.js';
import { heldGeometry } from './held.js';
import { NPC_MARKER_MATERIAL, TOY_MATERIALS, toyMaterial, type CharacterVariant } from './materials.js';
import { BONE_COUNT, BONE_PARENT, B } from './rig.js';
import type { BuiltCharacter } from './build.js';

export interface CharacterProps {
  appearance: Appearance;
  anim: AnimState;
  /** Increments to restart one-shot animations (wave / interact) even if anim is unchanged. */
  animSeq?: number;
  /** Item held in hand ('' = none). Unknown ids show a wrapped parcel. */
  held?: ItemId | '';
  /** Highlight (e.g. hovered / targeted): warm rim glow. */
  highlighted?: boolean;
  /** Cast shadows (disable for previews / low quality). */
  castShadow?: boolean;
  /** Optional ground speed (m/s) so walk/run cadence matches actual movement. */
  speed?: number;
  /** 'seat' (default): root is at the seat surface, legs dangle. 'ground': sitting on the floor. */
  sitStyle?: 'seat' | 'ground';
  /** 'npc' = glazed-ceramic finish + floating gem marker, clearly not a player. */
  variant?: CharacterVariant;
  /** Animation phase seed 0..1 (defaults to random per instance so crowds don't sync). */
  seed?: number;
}

const MARKER_GEO = new OctahedronGeometry(0.075, 0);

/** Cumulative CPU time spent animating characters (ms) — read by the dev gallery / perf checks. */
export const characterPerf = { ms: 0, updates: 0 };

class CharacterInstance {
  readonly mesh: SkinnedMesh;
  readonly bones: Bone[];
  readonly skeleton: Skeleton;
  readonly handL: Object3D;
  readonly handR: Object3D;
  constructor(readonly built: BuiltCharacter) {
    const bones: Bone[] = [];
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new Bone();
      b.position.set(built.rest[i * 3]!, built.rest[i * 3 + 1]!, built.rest[i * 3 + 2]!);
      bones.push(b);
      const parent = BONE_PARENT[i]!;
      if (parent >= 0) bones[parent]!.add(b);
    }
    this.bones = bones;
    this.mesh = new SkinnedMesh(built.geometry, TOY_MATERIALS.player);
    this.mesh.name = 'character';
    this.mesh.add(bones[0]!);
    this.mesh.updateMatrixWorld(true);
    this.skeleton = new Skeleton(bones);
    this.mesh.bind(this.skeleton);
    // Generous fixed bounds (covers raised arms, dance, sit) instead of per-frame skinned bounds.
    const h = built.topY;
    this.mesh.boundingSphere = new Sphere(new Vector3(0, h * 0.5, 0), h * 0.5 + 0.7);
    this.mesh.frustumCulled = true;
    this.handL = new Object3D();
    this.handL.position.set(...built.handL);
    bones[B.elbowL]!.add(this.handL);
    this.handR = new Object3D();
    this.handR.position.set(...built.handR);
    bones[B.elbowR]!.add(this.handR);
  }
  dispose() {
    this.skeleton.dispose();
  }
}

export const Character = memo(function Character({
  appearance,
  anim,
  animSeq = 0,
  held = '',
  highlighted = false,
  castShadow = true,
  speed,
  sitStyle = 'seat',
  variant = 'player',
  seed,
}: CharacterProps) {
  const { key, built } = getCharacter(appearance);
  const inst = useMemo(() => new CharacterInstance(built), [built]);
  const animator = useRef<Animator | null>(null);
  if (!animator.current) animator.current = new Animator(seed ?? Math.random());
  const marker = useRef<Mesh>(null);
  const inputs = useRef({ anim, animSeq, speed, sitStyle, holding: !!held });
  inputs.current.anim = anim;
  inputs.current.animSeq = animSeq;
  inputs.current.speed = speed;
  inputs.current.sitStyle = sitStyle;
  inputs.current.holding = !!held;

  useEffect(() => {
    retainCharacter(key);
    return () => releaseCharacter(key);
  }, [key]);
  useEffect(() => () => inst.dispose(), [inst]);

  inst.mesh.material = toyMaterial(variant, highlighted);
  inst.mesh.castShadow = castShadow;

  const heldMesh = useMemo(() => {
    if (!held) return null;
    const m = new Mesh(heldGeometry(held), toyMaterial('player', highlighted));
    m.name = 'held';
    m.scale.setScalar(1.6);
    return m;
  }, [held, highlighted]);
  useEffect(() => {
    if (!heldMesh) return;
    heldMesh.castShadow = castShadow;
    inst.handL.add(heldMesh);
    return () => {
      inst.handL.remove(heldMesh);
    };
  }, [heldMesh, inst, castShadow]);

  // Pose immediately so the first rendered frame is not the bind pose.
  useMemo(() => {
    animator.current!.update(0, inputs.current, inst.built.layout);
    animator.current!.apply(inst.bones, inst.built.rest);
  }, [inst]);

  useFrame((_, dt) => {
    const t0 = performance.now();
    const a = animator.current!;
    a.update(dt, inputs.current, inst.built.layout);
    a.apply(inst.bones, inst.built.rest);
    const m = marker.current;
    if (m) {
      m.position.y = inst.built.topY + 0.28 + a.markerBob;
      m.rotation.y = a.markerSpin;
    }
    characterPerf.ms += performance.now() - t0;
    characterPerf.updates++;
  });

  return (
    <group>
      <primitive object={inst.mesh} />
      {variant === 'npc' && <mesh ref={marker} geometry={MARKER_GEO} material={NPC_MARKER_MATERIAL} position={[0, built.topY + 0.28, 0]} scale={[1, 1.5, 1]} />}
    </group>
  );
});

export type { CharacterVariant };
