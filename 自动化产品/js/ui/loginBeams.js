const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float ribbon(vec2 p, float offset, float width, float phase) {
  float bend = sin(p.y * 3.2 + uTime * 0.34 + phase) * 0.055;
  bend += sin(p.y * 8.0 - uTime * 0.16 + phase * 1.7) * 0.016;
  float d = abs(p.x + bend - offset);
  float body = 1.0 - smoothstep(width * 0.22, width, d);
  float edge = 1.0 - smoothstep(width, width * 2.4, d);
  float pulse = 0.72 + 0.28 * sin(p.y * 5.0 - uTime * 0.24 + phase);
  return body * pulse + edge * 0.12;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  vec2 p = uv - 0.5;
  p.x *= uResolution.x / max(uResolution.y, 1.0);
  float a = -0.48;
  p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;

  float light = 0.0;
  light += ribbon(p, -0.72, 0.09, 0.4) * 0.72;
  light += ribbon(p, -0.45, 0.13, 1.7) * 0.90;
  light += ribbon(p, -0.12, 0.10, 3.1) * 0.78;
  light += ribbon(p,  0.19, 0.15, 4.8) * 0.96;
  light += ribbon(p,  0.54, 0.11, 6.2) * 0.70;
  light += ribbon(p,  0.82, 0.08, 7.9) * 0.58;

  float vignette = smoothstep(0.92, 0.18, length((uv - 0.5) * vec2(0.86, 1.0)));
  float grain = hash(gl_FragCoord.xy + floor(uTime * 8.0)) - 0.5;
  float tone = 0.012 + light * vignette * 0.72 + grain * 0.035;
  tone *= 0.82 + 0.18 * smoothstep(0.0, 0.72, uv.y);
  gl_FragColor = vec4(vec3(clamp(tone, 0.0, 0.92)), 1.0);
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
  if (!canvas || !gate) return;

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

    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, reducedMotion.matches ? 0 : (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!gate.hidden && !reducedMotion.matches) frame = requestAnimationFrame(draw);
    };

    const sync = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!gate.hidden) {
        start = performance.now();
        frame = requestAnimationFrame(draw);
      }
    };

    new MutationObserver(sync).observe(gate, { attributes: true, attributeFilter: ["hidden"] });
    window.addEventListener("resize", () => { if (!gate.hidden && !frame) frame = requestAnimationFrame(draw); }, { passive: true });
    reducedMotion.addEventListener?.("change", sync);
    sync();
  } catch (error) {
    console.warn("[login-beams]", error);
    gate.classList.add("beams-fallback");
  }
}
