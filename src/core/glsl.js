// 共有 GLSL ライブラリ（ノイズ・コースティクス・水中効果）

export const NOISE_GLSL = /* glsl */ `
#ifndef KANI_NOISE
#define KANI_NOISE
// 長さ 0 のベクトルを正規化して NaN を出さないための安全版
vec3 safeNormalize(vec3 v, vec3 fallback) { float l2 = dot(v, v); return l2 > 1e-12 ? v * inversesqrt(l2) : fallback; }
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

float vnoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// Simplex 3D (Ashima Arts / Stefan Gustavson, MIT)
vec3 _m289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _m289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _perm(vec4 x) { return _m289(((x * 34.0) + 10.0) * x); }
vec4 _tis(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _m289(i);
  vec4 p = _perm(_perm(_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _tis(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * snoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
float fbm3v(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * (vnoise3(p) * 2.0 - 1.0); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
float fbm2v(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * (vnoise2(p) * 2.0 - 1.0); p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(3.1, 1.7); a *= 0.5; }
  return s;
}

// Worley: x = F1 距離, y = セルID
vec2 worley2(vec2 p) {
  vec2 n = floor(p); vec2 f = fract(p);
  float md = 8.0; float id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; id = hash12(n + g + 7.13); }
  }
  return vec2(sqrt(md), id);
}
vec2 worley3(vec3 p) {
  vec3 n = floor(p); vec3 f = fract(p);
  float md = 8.0; float id = 0.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 o = hash33(n + g);
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; id = hash13(n + g + 7.13); }
  }
  return vec2(sqrt(md), id);
}
#endif
`;

// 水面のコースティクス（Tileable Water Caustic, Dave_Hoskins 系の手法を改変）
export const CAUSTIC_GLSL = /* glsl */ `
#ifndef KANI_CAUSTIC
#define KANI_CAUSTIC
float causticLayer(vec2 uv, float time) {
  vec2 p = mod(uv * 6.28318530718, 6.28318530718) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(max(c, 0.0), 1.4);
  return pow(abs(c), 7.0);
}
#endif
`;

// 水中・コースティクス・濡れの共有シェーダ（MeshStandard/Physical 用）
export const WATERFX_PARS = /* glsl */ `
uniform float uTime;
uniform float uWaterLevel;
uniform float uCaustic;
uniform vec3 uWaterAbsorb;
uniform vec3 uWaterScatter;
uniform vec4 uTankInner;
uniform sampler2D uRippleTex;
uniform vec4 uRippleRect;
uniform vec3 uCausticLight;

vec2 rippleUV(vec2 xz) { return (xz - uRippleRect.xy) * uRippleRect.zw; }

float causticAt(vec3 wp, float depthBelow) {
  vec2 ruv = rippleUV(wp.xz);
  vec2 rg = vec2(0.0);
  float lap = 0.0;
  if (all(greaterThan(ruv, vec2(0.0))) && all(lessThan(ruv, vec2(1.0)))) {
    vec4 r = texture2D(uRippleTex, ruv);
    rg = r.zw;
    lap = r.y;
  }
  vec2 off = rg * depthBelow * 0.35;
  float ol = length(off);
  if (ol > 0.35) off *= 0.35 / ol;
  vec2 p = wp.xz + off;
  float t = uTime * 0.5;
  float a = causticLayer(p * 0.21 + vec2(0.13, 0.71), t);
  float b = causticLayer(p * 0.29 * mat2(0.8, 0.6, -0.6, 0.8) + vec2(3.1, 1.3), t * 1.21 + 11.0);
  float c = sqrt(max(a * b, 0.0)) * 2.4 + (a + b) * 0.22;
  // 平均がおよそ 1 になるよう正規化（光は集まるだけで失われない）。線を強調
  c = pow(max(c * 2.2, 0.0), 1.35) * 1.05;
  c = mix(1.0, c, 0.85);
  float focus = smoothstep(0.05, 1.0, depthBelow);
  c = mix(1.0, c, focus);
  c *= clamp(1.0 - lap * 8.0, 0.6, 1.6);
  return clamp(c, 0.2, 4.0);
}

float waterPath(vec3 wp) {
  if (wp.y >= uWaterLevel) return 0.0;
  vec3 dir = normalize(cameraPosition - wp);
  float t = 1e4;
  if (dir.y > 1e-4) t = min(t, (uWaterLevel - wp.y) / dir.y);
  if (dir.z > 1e-4) t = min(t, (uTankInner.w - wp.z) / dir.z);
  if (dir.z < -1e-4) t = min(t, (uTankInner.y - wp.z) / dir.z);
  if (dir.x > 1e-4) t = min(t, (uTankInner.z - wp.x) / dir.x);
  if (dir.x < -1e-4) t = min(t, (uTankInner.x - wp.x) / dir.x);
  return max(t, 0.0);
}
`;

// lights_fragment_end の後に挿入: コースティクス
export const WATERFX_LIGHT = /* glsl */ `
{
  float depthBelow = uWaterLevel - vWPos.y;
  if (depthBelow > 0.0) {
    float cst = causticAt(vWPos, depthBelow);
    float k = smoothstep(0.0, 0.35, depthBelow) * uCaustic;
    reflectedLight.directDiffuse *= mix(1.0, cst, k);
    reflectedLight.indirectDiffuse *= mix(1.0, 0.75 + 0.25 * cst, k);
    // 水中では石と水の屈折率差が小さく、反射はずっと弱い
    float uw = smoothstep(0.0, 0.25, depthBelow);
    reflectedLight.directSpecular *= mix(1.0, 0.1, uw);
    reflectedLight.indirectSpecular *= mix(1.0, 0.18, uw);
  } else {
    // 水面反射によるゆらめき（水際の岩肌などに映る）
    float h = -depthBelow;
    float near = exp(-h * 0.9) * smoothstep(0.0, 0.1, h);
    if (near > 0.01) {
      float cst = causticAt(vec3(vWPos.x, uWaterLevel, vWPos.z) + vec3(0.0, 0.0, h * 1.3), 1.0);
      reflectedLight.directDiffuse += material.diffuseContribution * uCausticLight * max(cst - 0.45, 0.0) * near * 0.35 * uCaustic;
    }
  }
}
`;

// opaque_fragment の前に挿入: 水中の吸収・散乱
export const WATERFX_FOG = /* glsl */ `
{
  float wpath = waterPath(vWPos);
  if (wpath > 0.0) {
    vec3 trans = exp(-uWaterAbsorb * wpath);
    outgoingLight = outgoingLight * trans + uWaterScatter * (1.0 - trans);
  }
}
`;

// ワールド座標 varying（頂点側）
export const WORLDPOS_VERT_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
`;
export const WORLDPOS_VERT = /* glsl */ `
{
  vec4 _wp = vec4(transformed, 1.0);
  vec3 _wn = objectNormal;
  #ifdef USE_BATCHING
    _wp = batchingMatrix * _wp;
  #endif
  #ifdef USE_INSTANCING
    _wp = instanceMatrix * _wp;
    _wn = mat3(instanceMatrix) * _wn;
  #endif
  vWPos = (modelMatrix * _wp).xyz;
  vWNrm = normalize(mat3(modelMatrix) * _wn);
}
`;
export const WORLDPOS_FRAG_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
`;
