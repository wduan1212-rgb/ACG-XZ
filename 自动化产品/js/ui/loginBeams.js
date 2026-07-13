const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uResolution;
uniform vec2 uMouse;
uniform float uMouseActive;
uniform float uTime;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

mat2 rotate2d(float angle) {
  float s = sin(angle), c = cos(angle);
  return mat2(c, -s, s, c);
}

float starLayer(vec2 uv, float scale, float seed, float time) {
  vec2 gridUv = uv * scale;
  vec2 cell = floor(gridUv);
  vec2 local = fract(gridUv) - 0.5;
  float rnd = hash21(cell + seed);
  vec2 offset = vec2(hash21(cell + seed + 7.2), hash21(cell + seed + 19.4)) - 0.5;
  local -= offset * 0.62;
  float radius = mix(0.015, 0.11, pow(rnd, 10.0));
  float dist = length(local);
  float glow = smoothstep(radius, 0.0, dist);
  glow += radius / max(dist, 0.012) * smoothstep(0.34, 0.07, dist) * 0.22;
  float rays = max(0.0, 1.0 - abs(local.x * local.y) * 520.0) * smoothstep(0.06, 0.0, dist);
  float twinkle = 0.68 + 0.32 * sin(time * (0.55 + rnd) + rnd * 18.0);
  return (glow + rays * 0.4) * step(0.79, rnd) * twinkle;
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
  vec2 p = uv - 0.5;
  p.x *= uResolution.x / max(uResolution.y, 1.0);

  vec2 mouse = uMouse;
  mouse.x *= uResolution.x / max(uResolution.y, 1.0);
  vec2 delta = p - mouse;
  float lens = exp(-dot(delta, delta) * 7.5) * uMouseActive;
  p += normalize(delta + vec2(0.0001)) * lens * 0.055;

  float radius = length(p);
  float angle = atan(p.y, p.x);
  float spiral = angle + radius * 2.3 - uTime * 0.035;
  vec2 galaxyUv = rotate2d(spiral * 0.065) * p;

  float stars = 0.0;
  stars += starLayer(galaxyUv + vec2(uTime * 0.003, 0.0), 18.0, 1.0, uTime) * 0.70;
  stars += starLayer(galaxyUv - vec2(0.0, uTime * 0.004), 29.0, 11.0, uTime) * 0.54;
  stars += starLayer(galaxyUv + vec2(uTime * 0.006), 43.0, 29.0, uTime) * 0.38;

  float band = exp(-pow(abs(sin(spiral * 1.42)) * 1.45 + radius * 0.72, 2.0) * 2.0);
  float core = exp(-radius * 5.2);
  float dust = hash21(floor((galaxyUv + uTime * 0.0008) * 240.0)) * 0.035;
  vec3 nebula = mix(vec3(0.035, 0.055, 0.13), vec3(0.19, 0.09, 0.28), smoothstep(-0.5, 0.6, galaxyUv.x));
  vec3 color = vec3(0.004, 0.006, 0.018);
  color += nebula * band * (0.22 + core * 0.5);
  color += vec3(0.56, 0.68, 1.0) * stars;
  color += vec3(0.23, 0.46, 0.95) * lens * 0.045;
  color += dust;
  float vignette = smoothstep(0.98, 0.18, length((uv - 0.5) * vec2(0.82, 1.0)));
  color *= 0.50 + vignette * 0.62;
  gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(0.82)), 1.0);
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
  if (!canvas || !gate || canvas.dataset.galaxyReady) return;
  canvas.dataset.galaxyReady = "1";

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) {
    gate.classList.add("galaxy-fallback");
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

    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");
    const mouse = gl.getUniformLocation(program, "uMouse");
    const mouseActive = gl.getUniformLocation(program, "uMouseActive");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = performance.now();
    let targetX = 0, targetY = 0, currentX = 0, currentY = 0, activity = 0;

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

    const onPointerMove = event => {
      if (reducedMotion.matches) return;
      const rect = canvas.getBoundingClientRect();
      targetX = ((event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * 2;
      targetY = (0.5 - (event.clientY - rect.top) / Math.max(rect.height, 1)) * 2;
      activity = 1;
    };
    gate.addEventListener("pointermove", onPointerMove, { passive: true });
    gate.addEventListener("pointerleave", () => { targetX = 0; targetY = 0; activity = 0; }, { passive: true });

    const draw = now => {
      frame = 0;
      resize();
      currentX += (targetX - currentX) * 0.055;
      currentY += (targetY - currentY) * 0.055;
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform2f(mouse, currentX, currentY);
      gl.uniform1f(mouseActive, reducedMotion.matches ? 0 : activity);
      gl.uniform1f(time, reducedMotion.matches ? 0 : (now - start) / 1000);
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
    canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); gate.classList.add("galaxy-fallback"); }, false);
    sync();
  } catch (error) {
    console.warn("[login-galaxy]", error);
    gate.classList.add("galaxy-fallback");
  }
}
