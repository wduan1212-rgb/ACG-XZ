/* 统一 SVG 线性图标库（替代全站 emoji 图标） */

const P = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  spark: 'M12 2l2.1 5.6L20 10l-5.9 2.4L12 18l-2.1-5.6L4 10l5.9-2.4L12 2z|M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3',
  film: 'M4 6h11v12H4z|M15 10l5-3v10l-5-3z',
  image: 'M4 5h16v14H4z|M4 15l4-4 3 3 4-5 5 6',
  folder: 'M3 7a2 2 0 012-2h4l2 2h9a1 1 0 011 1v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5V8z|M3.3 8.3L12 13l8.7-4.7|M12 13v8',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6z|M19.4 13a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-2.94.67 2 2 0 11-3.96 0 1.65 1.65 0 00-2.94-.67l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 13a2 2 0 110-3.96 1.65 1.65 0 00.67-2.94l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 002.94-.67 2 2 0 113.96 0 1.65 1.65 0 002.94.67l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.67 2.94 2 2 0 110 3.96z',
  search: 'M21 21l-4.3-4.3M11 19a8 8 0 110-16 8 8 0 010 16z',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8|M10.3 21a2 2 0 003.4 0',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7V5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  upload: 'M12 16V4m0 0L7 9m5-5l5 5|M4 20h16',
  download: 'M12 4v12m0 0l5-5m-5 5l-5-5|M4 20h16',
  check: 'M5 13l5 5L20 6',
  checkCircle: 'M12 22a10 10 0 100-20 10 10 0 000 20z|M8 12l3 3 5-6',
  x: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  arrowRight: 'M5 12h14m0 0l-6-6m6 6l-6 6',
  arrowLeft: 'M19 12H5m0 0l6-6m-6 6l6 6',
  trash: 'M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13|M10 11v5M14 11v5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z|M13 7l4 4',
  copy: 'M9 9h11v11H9z|M5 15H4V4h11v1',
  refresh: 'M21 12a9 9 0 11-2.6-6.3M21 4v5h-5',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20z|M12 7v5l3 3',
  user: 'M12 11a4 4 0 100-8 4 4 0 000 8z|M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  users: 'M9 11a4 4 0 100-8 4 4 0 000 8z|M2 21c1.2-3.5 3.8-5 7-5s5.8 1.5 7 5|M16 3.5a4 4 0 010 7.5M17.5 16c2 .8 3.5 2.4 4.5 5',
  layers: 'M12 2l9 5-9 5-9-5 9-5z|M3 12l9 5 9-5|M3 17l9 5 9-5',
  list: 'M8 6h13M8 12h13M8 18h13|M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  command: 'M9 9V6a3 3 0 10-3 3h3zm0 0v6m0-6h6m-6 6H6a3 3 0 103 3v-3zm6 0V6a3 3 0 113 3h-3zm0 0v6m0 0h3a3 3 0 11-3 3v-3z',
  scissors: 'M9.2 9.2L20 20M9.2 14.8L20 4|M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6z',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  wand: 'M5 19l9-9|M14.5 4.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1 1-2.2z|M19 13l.6 1.4L21 15l-1.4.6L19 17l-.6-1.4L17 15l1.4-.6L19 13z',
  dice: 'M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z|M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01',
  send: 'M22 2L11 13|M22 2l-7 20-4-9-9-4 20-7z',
  alert: 'M12 2L1 21h22L12 2z|M12 9v5M12 17.5h.01',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20z|M12 11v6M12 7.5h.01',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z|M12 15a3 3 0 100-6 3 3 0 000 6z',
  link: 'M10 14a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.5 1.5|M14 10a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7L12 18',
  undo: 'M4 10h11a5 5 0 015 5v1|M4 10l5-5M4 10l5 5',
  zoomIn: 'M21 21l-4.3-4.3M11 19a8 8 0 110-16 8 8 0 010 16z|M11 8v6M8 11h6',
  zoomOut: 'M21 21l-4.3-4.3M11 19a8 8 0 110-16 8 8 0 010 16z|M8 11h6',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4|M16 17l5-5-5-5|M21 12H9',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3|M1 14h6M9 8h6M17 16h6',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1L12 2z',
  lock: 'M5 11h14v10H5z|M8 11V7a4 4 0 118 0v4',
  unlock: 'M5 11h14v10H5z|M8 11V7a4 4 0 017.8-1.2',
  external: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6|M15 3h6v6|M10 14L21 3',
  video: 'M4 6h11v12H4z|M15 10l5-3v10l-5-3z',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z|M6 11a6 6 0 0012 0|M12 17v4',
  fileText: 'M6 2h9l5 5v15H6z|M14 2v6h6|M9 13h6M9 17h6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2|M5 4h14l3 8v8H2v-8l3-8z',
  filter: 'M22 4H2l8 9v6l4 2v-8l8-9z',
  more: 'M12 13a1 1 0 100-2 1 1 0 000 2zM5 13a1 1 0 100-2 1 1 0 000 2zM19 13a1 1 0 100-2 1 1 0 000 2z',
  home: 'M3 10l9-7 9 7v10a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1V10z',
  bot: 'M9 7V4h6v3|M5 7h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z|M9 13h.01M15 13h.01M9.5 16.5c.8.7 4.2.7 5 0',
  pulse: 'M2 12h4l3-8 4 16 3-8h6',
  package: 'M16.5 9.4L7.5 4.2|M21 8l-9-5-9 5v8l9 5 9-5V8z|M3.3 8.3L12 13l8.7-4.7|M12 13v8',
  kanban: 'M4 4h16v16H4z|M9 4v16M15 4v10',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10z|M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  moon: 'M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  split: 'M12 3v18|M7 8L3 12l4 4M17 8l4 4-4 4',
  music: 'M9 18V5l12-2v13|M6 21a3 3 0 100-6 3 3 0 000 6zM18 19a3 3 0 100-6 3 3 0 000 6z',
  archive: 'M21 8v13H3V8|M1 3h22v5H1z|M10 12h4'
};

export function icon(name, size = 16, cls = "") {
  const d = P[name] || P.info;
  const paths = d.split("|").map(p => `<path d="${p}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`;
}

/* 品牌标识：ACG TV 横向字标（A 紫渐变 + CG 随文字色 + TV 蓝渐变 + 渐变描边播放三角） */
export function brandMark(height = 28) {
  const w = Math.round(height * 4.7);
  return `<svg viewBox="0 0 235 50" width="${w}" height="${height}" aria-hidden="true">
    <defs>
      <linearGradient id="acgWa" x1="0" y1="4" x2="40" y2="46" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#C77CFF"/><stop offset="1" stop-color="#6A5BFF"/>
      </linearGradient>
      <linearGradient id="acgWt" x1="120" y1="22" x2="158" y2="44" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#5B8CFF"/><stop offset="1" stop-color="#22B8CF"/>
      </linearGradient>
      <linearGradient id="acgWp" x1="172" y1="4" x2="232" y2="46" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#B07CFF"/><stop offset="1" stop-color="#22A8E8"/>
      </linearGradient>
    </defs>
    <text x="0" y="39" font-family="Inter,'PingFang SC',system-ui,sans-serif" font-size="38" font-weight="800" letter-spacing="1.5"><tspan fill="url(#acgWa)">A</tspan><tspan fill="currentColor">CG</tspan></text>
    <text x="120" y="39" font-family="Inter,'PingFang SC',system-ui,sans-serif" font-size="21" font-weight="800" letter-spacing="1" fill="url(#acgWt)">TV</text>
    <path d="M180 9 L220 25 L180 41 Z" fill="none" stroke="url(#acgWp)" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* 方形小标（导航栏 / favicon 同款）：深色圆角底 + 渐变描边播放三角 */
export function brandGlyph(size = 28) {
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">
    <defs>
      <linearGradient id="acgGl" x1="8" y1="8" x2="42" y2="40" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#B07CFF"/><stop offset="1" stop-color="#22A8E8"/>
      </linearGradient>
    </defs>
    <rect width="48" height="48" rx="11" fill="#0A0D18"/>
    <path d="M16 11 L38.5 24 L16 37 Z" fill="none" stroke="url(#acgGl)" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* Agent 头像：渐变描边机器人（按参考图重绘：天线 + 圆角头壳 + 深色面板 + 双色发光眼） */
export function agentAvatar(size = 34) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
    <defs>
      <linearGradient id="agR" x1="8" y1="14" x2="56" y2="54" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#A86CFF"/><stop offset="1" stop-color="#2E7CF6"/>
      </linearGradient>
      <linearGradient id="agEL" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#C08CFF"/><stop offset="1" stop-color="#7A5CFF"/>
      </linearGradient>
      <linearGradient id="agER" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5FA8FF"/><stop offset="1" stop-color="#2E6CF6"/>
      </linearGradient>
    </defs>
    <!-- 天线 -->
    <line x1="32" y1="16" x2="32" y2="9" stroke="url(#agR)" stroke-width="3.6" stroke-linecap="round"/>
    <circle cx="32" cy="7" r="3.6" fill="url(#agR)"/>
    <!-- 侧耳 -->
    <rect x="5" y="29" width="7" height="14" rx="3.5" fill="#9D6CFF"/>
    <rect x="52" y="29" width="7" height="14" rx="3.5" fill="#3E8CF6"/>
    <!-- 头壳（渐变描边） -->
    <rect x="10" y="16" width="44" height="40" rx="17" fill="#fff" stroke="url(#agR)" stroke-width="4.6"/>
    <!-- 面板 -->
    <rect x="17" y="24" width="30" height="24" rx="10.5" fill="#10142A"/>
    <!-- 双色发光眼 -->
    <rect x="25" y="30" width="5.2" height="12" rx="2.6" fill="url(#agEL)"/>
    <rect x="34" y="30" width="5.2" height="12" rx="2.6" fill="url(#agER)"/>
  </svg>`;
}
