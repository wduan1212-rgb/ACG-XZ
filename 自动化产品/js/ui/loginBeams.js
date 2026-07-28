/* React Bits Silk shader, ported from React Three Fiber to the platform's
   existing dependency-free WebGL login canvas.
   Copyright (c) 2026 David Haz
   MIT + Commons Clause License Condition v1.0:
   https://github.com/DavidHDev/react-bits */
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
uniform vec3  uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;

const float e = 2.71828182845904523536;

float noise(vec2 texCoord) {
  float G = e;
  vec2  r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2  rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  float rnd        = noise(gl_FragCoord.xy);
  vec2  uv         = rotateUvs(vUv * uScale, uRotation);
  vec2  tex        = uv * uScale;
  float tOffset    = uSpeed * uTime;

  tex.y += 0.03 * sin(8.0 * tex.x - tOffset);

  float pattern = 0.6 +
                  0.4 * sin(5.0 * (tex.x + tex.y +
                                   cos(3.0 * tex.x + 5.0 * tex.y) +
                                   0.02 * tOffset) +
                           sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));

  vec4 col = vec4(uColor, 1.0) * vec4(pattern) - rnd / 15.0 * uNoiseIntensity;
  col.a = 1.0;
  gl_FragColor = col;
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
    const color = gl.getUniformLocation(program, "uColor");
    const speed = gl.getUniformLocation(program, "uSpeed");
    const scale = gl.getUniformLocation(program, "uScale");
    const rotation = gl.getUniformLocation(program, "uRotation");
    const noiseIntensity = gl.getUniformLocation(program, "uNoiseIntensity");
    gl.uniform3f(color, 0.92, 0.92, 0.92);
    gl.uniform1f(speed, 5);
    gl.uniform1f(scale, 1.28);
    gl.uniform1f(rotation, 0.08);
    gl.uniform1f(noiseIntensity, 1.4);

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
    console.warn("[login-silk]", error);
    gate.classList.add("beams-fallback");
  }
}
