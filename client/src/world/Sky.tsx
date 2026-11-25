/**
 * Screen-space backdrop behind the diorama: time-of-day gradient with a warm
 * sun-side glow, stars and a moon at night. Optional vignette overlay (post).
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import { PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { env, uniforms } from './env.js';

export function Sky({ vignette }: { vignette: boolean }) {
  const size = useThree((s) => s.size);
  const { geo, sky, vig, res } = useMemo(() => {
    const res = { value: new Vector2(1, 1) };
    const sunScreen = { value: new Vector2(0.1, 0.9) };
    const sky = new ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: { uBgTop: uniforms.uBgTop, uBgBottom: uniforms.uBgBottom, uNight: uniforms.uNight, uTime: uniforms.uTime, uRes: res, uSun: sunScreen, uSunColor: uniforms.uSunColor, uSunI: uniforms.uSunIntensity },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.9999, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBgTop; uniform vec3 uBgBottom; uniform float uNight; uniform float uTime; uniform vec2 uRes; uniform vec2 uSun; uniform vec3 uSunColor; uniform float uSunI;
        varying vec2 vUv;
        float h(vec2 p){ p = fract(p*vec2(443.897, 441.423)); p += dot(p, p.yx+19.19); return fract((p.x+p.y)*p.x); }
        void main(){
          vec2 uv = vUv;
          float t = smoothstep(0.0, 1.0, uv.y);
          vec3 c = mix(uBgBottom, uBgTop, t);
          // soft radial lift in the centre (spotlit tabletop feel)
          vec2 asp = vec2(uRes.x / uRes.y, 1.0);
          float r = length((uv - vec2(0.5, 0.45)) * asp);
          c *= 1.06 - 0.16 * smoothstep(0.2, 1.1, r);
          // sun-side glow near the upper-left at low sun
          float sd = length((uv - uSun) * asp);
          c += uSunColor * pow(max(0.0, 1.0 - sd * 1.1), 3.0) * 0.18 * clamp(uSunI, 0.0, 2.5) * (1.0 - uNight);
          // stars
          if (uNight > 0.05) {
            vec2 g = floor(uv * asp * 120.0);
            float s = h(g);
            float tw = 0.6 + 0.4 * sin(uTime * (1.0 + s * 3.0) + s * 40.0);
            vec2 f = fract(uv * asp * 120.0) - 0.5;
            float star = step(0.985, s) * smoothstep(0.35, 0.0, length(f)) * tw;
            c += vec3(0.9, 0.92, 1.0) * star * uNight * smoothstep(0.25, 0.7, uv.y);
            // moon (upper right)
            vec2 mp = vec2(0.82, 0.8);
            float md = length((uv - mp) * asp);
            float disc = smoothstep(0.045, 0.04, md);
            float crater = smoothstep(0.02, 0.0, length((uv - mp - vec2(0.012, 0.008)) * asp)) * 0.08;
            c = mix(c, vec3(0.97, 0.95, 0.88) - crater, disc * uNight);
            c += vec3(0.5, 0.55, 0.75) * pow(max(0.0, 1.0 - md * 5.0), 2.0) * 0.25 * uNight;
          }
          // subtle paper grain
          c *= 0.985 + 0.03 * h(floor(uv * uRes));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    sky.toneMapped = false;
    const vig = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { uRes: res, uNight: uniforms.uNight, uSunColor: uniforms.uSunColor },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec2 uRes; uniform float uNight; uniform vec3 uSunColor; varying vec2 vUv;
        void main(){
          vec2 asp = vec2(uRes.x / uRes.y, 1.0);
          float r = length((vUv - 0.5) * asp);
          float v = smoothstep(0.55, 1.25, r);
          gl_FragColor = vec4(mix(vec3(0.12, 0.08, 0.1), vec3(0.03, 0.04, 0.1), uNight), v * (0.32 + 0.15 * uNight));
        }`,
    });
    const geo = new PlaneGeometry(1, 1);
    return { geo, sky, vig, res, sunScreen };
  }, []);

  useFrame(() => {
    res.value.set(size.width, size.height);
    // Sun glow sits on the side the light comes from (east = right in the morning, west = upper-left in the evening).
    const morning = env.hours < 12;
    (sky.uniforms.uSun!.value as Vector2).set(morning ? 0.92 : 0.06, morning ? 0.55 : 0.88);
  });

  return (
    <>
      <mesh geometry={geo} material={sky} frustumCulled={false} renderOrder={-100} />
      {vignette && <mesh geometry={geo} material={vig} frustumCulled={false} renderOrder={1000} />}
    </>
  );
}
