/*
 * StarMatrix 首页局部光束：受 Lightfall 的“下落光迹 + 鼠标辉光”交互启发，
 * 使用原生 Canvas 2D 独立实现，避免为首页引入 React/WebGL 运行时依赖。
 */

const COLORS = [
  [93, 165, 255],
  [143, 155, 255],
  [112, 208, 255],
];

function makeStreak(index, count) {
  const seed = ((index * 47) % Math.max(1, count)) / Math.max(1, count - 1);
  return {
    x: seed,
    phase: ((index * 73) % Math.max(1, count)) / count,
    speed: 0.018 + (index % 5) * 0.0045,
    length: 0.14 + (index % 4) * 0.035,
    width: 0.7 + (index % 3) * 0.55,
    color: COLORS[index % COLORS.length],
  };
}

export function mountHomeLightfall(host, { interactionTarget = host } = {}) {
  if (!(host instanceof HTMLElement)) return { destroy() {} };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const canvas = document.createElement("canvas");
  canvas.className = "home-lightfall-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.replaceChildren(canvas);
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return { destroy() { canvas.remove(); } };

  const streaks = Array.from({ length: reduceMotion ? 8 : 22 }, (_, index) => makeStreak(index, reduceMotion ? 8 : 22));
  const pointer = { x: 0.5, y: 0.54, tx: 0.5, ty: 0.54, active: false };
  let width = 1;
  let height = 1;
  let dpr = 1;
  let visible = true;
  let frame = 0;
  let startedAt = performance.now();
  let lastDrawAt = 0;
  let hostRect = host.getBoundingClientRect();

  const resize = () => {
    hostRect = host.getBoundingClientRect();
    width = Math.max(1, hostRect.width);
    height = Math.max(1, hostRect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const glow = (x, y, radius, color, alpha) => {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${color.join(",")},${alpha})`);
    gradient.addColorStop(0.48, `rgba(${color.join(",")},${alpha * 0.34})`);
    gradient.addColorStop(1, `rgba(${color.join(",")},0)`);
    context.fillStyle = gradient;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  };

  const draw = now => {
    context.clearRect(0, 0, width, height);
    const elapsed = reduceMotion ? 0 : (now - startedAt) / 1000;
    pointer.x += (pointer.tx - pointer.x) * 0.08;
    pointer.y += (pointer.ty - pointer.y) * 0.08;

    if (pointer.active) glow(pointer.x * width, pointer.y * height, Math.max(150, width * 0.16), COLORS[1], 0.14);

    context.save();
    context.globalCompositeOperation = "lighter";
    streaks.forEach((streak, index) => {
      const travel = (streak.phase + elapsed * streak.speed) % 1.18;
      const y = travel * (height * 1.18) - height * 0.16;
      const progress = Math.max(0.08, Math.min(1, y / height));
      const spread = width * (0.18 + progress * 0.82);
      const x = width * 0.5 + (streak.x - 0.5) * spread;
      const length = Math.max(26, height * streak.length * (0.46 + progress * 0.8));
      const [r, g, b] = streak.color;
      const gradient = context.createLinearGradient(x, y - length, x, y + length * 0.18);
      gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
      gradient.addColorStop(0.72, `rgba(${r},${g},${b},${0.055 + (index % 4) * 0.012})`);
      gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
      context.strokeStyle = gradient;
      context.lineWidth = streak.width * (0.7 + progress * 1.15);
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(x, y - length);
      context.quadraticCurveTo(x + (streak.x - 0.5) * 24, y - length * 0.3, x, y + length * 0.18);
      context.stroke();
    });
    context.restore();
  };

  const loop = now => {
    frame = 0;
    if (!visible || document.hidden || !host.isConnected) return;
    if (now - lastDrawAt >= 22) {
      draw(now);
      lastDrawAt = now;
    }
    if (!reduceMotion) frame = requestAnimationFrame(loop);
  };

  const wake = () => {
    if (frame || !visible || document.hidden || !host.isConnected) return;
    startedAt = performance.now();
    frame = requestAnimationFrame(loop);
  };
  const onPointerMove = event => {
    pointer.tx = Math.max(0, Math.min(1, (event.clientX - hostRect.left) / Math.max(1, hostRect.width)));
    pointer.ty = Math.max(0, Math.min(1, (event.clientY - hostRect.top) / Math.max(1, hostRect.height)));
    pointer.active = true;
  };
  const onPointerEnter = () => {
    hostRect = host.getBoundingClientRect();
  };
  const onPointerLeave = () => {
    pointer.tx = 0.5;
    pointer.ty = 0.54;
    pointer.active = false;
  };
  const onVisibility = () => {
    if (document.hidden && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else wake();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersectionObserver = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting !== false;
    if (!visible && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else wake();
  }, { threshold: 0.02 });
  intersectionObserver.observe(host);
  if (!reduceMotion) {
    interactionTarget?.addEventListener("pointerenter", onPointerEnter, { passive: true });
    interactionTarget?.addEventListener("pointermove", onPointerMove, { passive: true });
    interactionTarget?.addEventListener("pointerleave", onPointerLeave, { passive: true });
  }
  document.addEventListener("visibilitychange", onVisibility);
  resize();
  draw(performance.now());
  if (!reduceMotion) wake();

  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      interactionTarget?.removeEventListener("pointerenter", onPointerEnter);
      interactionTarget?.removeEventListener("pointermove", onPointerMove);
      interactionTarget?.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.remove();
    },
  };
}
