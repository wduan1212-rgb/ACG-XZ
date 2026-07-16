import { sanitizeXhsText } from "../core/xhsGuard.js";

export const DIGITAL_SEGMENT_TARGET_SEC = 27;
export const DIGITAL_SEGMENT_MAX_SEC = 30;
export const DIGITAL_SPEECH_CHARS_PER_SEC = 5;
export const DIGITAL_HUMAN_FIXED_PROMPT = "角色动作自然，表情自然生动，语言表达流畅，视线自然看镜头，自然地讲述内容。";

export function planDigitalSegmentGroups(durations = [], {
  target = DIGITAL_SEGMENT_TARGET_SEC,
  max = DIGITAL_SEGMENT_MAX_SEC,
  short = 8
} = {}) {
  const values = durations.map(value => Math.min(max, Math.max(3, Number(value || 0) || 3)));
  const dp = Array(values.length + 1).fill(null);
  dp[values.length] = { groups: [], count: 0, shortPenalty: 0, targetPenalty: 0 };
  for (let start = values.length - 1; start >= 0; start--) {
    let sum = 0;
    for (let end = start; end < values.length; end++) {
      sum += values[end];
      if (sum > max && end > start) break;
      const rest = dp[end + 1];
      if (!rest) continue;
      const clipped = Math.min(max, sum);
      const candidate = {
        groups: [{ indexes: Array.from({ length: end - start + 1 }, (_, i) => start + i), dur: clipped }, ...rest.groups],
        count: rest.count + 1,
        shortPenalty: rest.shortPenalty + (clipped < short ? short - clipped : 0),
        targetPenalty: rest.targetPenalty + Math.abs(target - clipped)
      };
      const current = dp[start];
      const better = !current
        || candidate.count < current.count
        || (candidate.count === current.count && candidate.shortPenalty < current.shortPenalty)
        || (candidate.count === current.count && candidate.shortPenalty === current.shortPenalty && candidate.targetPenalty < current.targetPenalty);
      if (better) dp[start] = candidate;
      if (sum >= max) break;
    }
  }
  return dp[0]?.groups || [];
}

function digitalSpeechPieces(shots = []) {
  const maxChars = Math.floor(DIGITAL_SEGMENT_MAX_SEC * DIGITAL_SPEECH_CHARS_PER_SEC);
  const pieces = [];
  shots.forEach((shot, shotIndex) => {
    const line = sanitizeXhsText(String(shot?.line || "").trim());
    if (!line) return;
    const clauses = line.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [line];
    clauses.forEach(clause => {
      const clean = clause.trim();
      if (!clean) return;
      const compactLength = clean.replace(/[\s，。、！？!?,.；;]/g, "").length;
      if (compactLength <= maxChars) {
        pieces.push({ shotIndex, line: clean, dur: Math.max(3, compactLength / DIGITAL_SPEECH_CHARS_PER_SEC) });
        return;
      }
      for (let start = 0; start < clean.length; start += maxChars) {
        const part = clean.slice(start, start + maxChars).trim();
        const n = part.replace(/[\s，。、！？!?,.；;]/g, "").length;
        if (part) pieces.push({ shotIndex, line: part, dur: Math.max(3, n / DIGITAL_SPEECH_CHARS_PER_SEC) });
      }
    });
  });
  return pieces;
}

export function planDigitalNarrationSegments(shots = []) {
  const pieces = digitalSpeechPieces(shots);
  const groups = planDigitalSegmentGroups(pieces.map(piece => piece.dur));
  return groups.map(group => {
    const rows = group.indexes.map(index => pieces[index]).filter(Boolean);
    return {
      shotIndexes: [...new Set(rows.map(row => row.shotIndex))],
      line: rows.map(row => row.line).join("\n"),
      dur: Math.round(group.dur * 10) / 10
    };
  }).filter(segment => segment.line);
}
