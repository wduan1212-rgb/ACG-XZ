/* 原创的依赖无关 WebGL 颗粒渐变，用于登录页左侧视觉。
   只沿用项目原有 Canvas 入口，不引入外部组件或限制性素材。 */
const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
varying vec3 vPosition;

void main() {
  vPosition = vec3(aPosition, 0.0);
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUv;
varying vec3 vPosition;

uniform float uTime;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;
uniform vec2  uResolution;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += vec2(dot(p, p + vec2(45.32)));
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

float fbm(vec2 p) {
  float result = 0.0;
  float amplitude = 0.52;
  for (int i = 0; i < 4; i++) {
    result += amplitude * valueNoise(p);
    p = mat2(1.56, 1.18, -1.18, 1.56) * p + vec2(7.13);
    amplitude *= 0.48;
  }
  return result;
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2  rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 centered = vUv - 0.5;
  centered.x *= aspect;
  centered = rotateUvs(centered, uRotation) * uScale;

  float t = uTime * uSpeed;
  vec2 flowA = centered * 1.12 + vec2(t * 0.055, -t * 0.032);
  vec2 flowB = centered * 1.72 + vec2(-t * 0.036, t * 0.047);
  float broad = fbm(flowA + vec2(fbm(flowB) * 0.66));
  float ribbon = fbm(flowB + vec2(broad * 1.3, -broad * 0.82));
  float diagonal = smoothstep(-0.76, 0.82, centered.x * 0.68 - centered.y + ribbon * 0.72);
  float bloom = smoothstep(0.12, 0.92, broad * 0.72 + ribbon * 0.54);

  vec3 deep = vec3(0.018, 0.055, 0.16);
  vec3 cyan = vec3(0.02, 0.82, 0.92);
  vec3 blue = vec3(0.055, 0.34, 0.98);
  vec3 violet = vec3(0.49, 0.17, 0.93);
  vec3 color = mix(deep, blue, smoothstep(0.02, 0.94, broad));
  color = mix(color, cyan, (1.0 - diagonal) * bloom * 0.84);
  color = mix(color, violet, diagonal * smoothstep(0.22, 0.92, ribbon) * 0.8);

  float vignette = 1.0 - smoothstep(0.18, 1.08, length(centered / vec2(max(aspect, 1.0), 1.0)));
  color *= mix(0.64, 1.08, vignette);
  float grain = (hash21(gl_FragCoord.xy + vec2(floor(t * 24.0))) - 0.5) * 0.07 * uNoiseIntensity;
  color += vec3(grain);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function initLoginBeams() {
  const canvas = document.querySelector("#lgBeams");
  const gate = document.querySelector("#loginGate");
  if (!canvas || !gate || canvas.dataset.silkReady) return;
  canvas.dataset.silkReady = "1";

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) {
    gate.classList.add("beams-fallback");
    return;
  }

  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const time = gl.getUniformLocation(program, "uTime");
    const speed = gl.getUniformLocation(program, "uSpeed");
    const scale = gl.getUniformLocation(program, "uScale");
    const rotation = gl.getUniformLocation(program, "uRotation");
    const noiseIntensity = gl.getUniformLocation(program, "uNoiseIntensity");
    const resolution = gl.getUniformLocation(program, "uResolution");
    gl.uniform1f(speed, 1.18);
    gl.uniform1f(scale, 1.05);
    gl.uniform1f(rotation, -0.12);
    gl.uniform1f(noiseIntensity, 0.9);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.uniform2f(resolution, width, height);
    };

    const draw = now => {
      frame = 0;
      resize();
      gl.uniform1f(time, reducedMotion.matches ? 0 : (now - start) / 10000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!gate.hidden && !reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(draw);
    };

    const sync = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!gate.hidden && !document.hidden) {
        start = performance.now();
        frame = requestAnimationFrame(draw);
      }
    };

    new MutationObserver(sync).observe(gate, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", sync, { passive: true });
    reducedMotion.addEventListener?.("change", sync);
    canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); gate.classList.add("beams-fallback"); }, false);
    sync();
  } catch (error) {
    console.warn("[login-grainient]", error);
    gate.classList.add("beams-fallback");
  }
}
