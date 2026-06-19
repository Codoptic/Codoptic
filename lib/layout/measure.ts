/**
 * SSR-safe text measurement.
 *
 * We avoid relying on a DOM canvas for layout so that ELK runs the same
 * on server and client. Uses a character-width approximation calibrated
 * against Inter at the relevant pixel sizes.
 */

const INTER_AVG_WIDTH = 0.55; // ratio of px width to font-size for average Inter glyphs
const NODE_LABEL_FONT_SIZE = 11;
const NODE_LABEL_WRAP_WIDTH = 150;
const NODE_LABEL_WIDTH_SAFETY = 1.35;
const NODE_ICON_GUTTER = 42;
const NODE_RIGHT_PADDING = 36;
const NODE_HEIGHT_PADDING = 22;
const NODE_MIN_WIDTH = 220;
const NODE_LINE_HEIGHT = NODE_LABEL_FONT_SIZE * 1.25;
const GROUP_TITLE_FONT_SIZE = 10;
const GROUP_TITLE_LETTER_SPACING = 0.5;
const GROUP_TITLE_TEXT_SAFETY = 1.35;
const GROUP_TITLE_HORIZONTAL_PADDING = 78;

export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split('\n');
  const width = lines.reduce((max, line) => Math.max(max, approxLineWidth(line, fontSize)), 0);
  const height = lines.length * fontSize * 1.25;
  return { width, height };
}

export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  widthSafety = 1,
): string[] {
  const lines: string[] = [];
  const safeLineWidth = (line: string) => approxLineWidth(line, fontSize) * widthSafety;
  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (safeLineWidth(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = '';
      }

      if (safeLineWidth(word) <= maxWidth) {
        current = word;
        continue;
      }

      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (chunk && safeLineWidth(next) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = next;
        }
      }
      current = chunk;
    }

    if (current) lines.push(current);
  }

  return lines.length > 0 ? lines : [''];
}

export function measureWrappedText(
  text: string,
  fontSize: number,
  maxWidth: number,
  widthSafety = 1,
): { width: number; height: number; lines: string[] } {
  const lines = wrapText(text, fontSize, maxWidth, widthSafety);
  const width = lines.reduce((max, line) => Math.max(max, approxLineWidth(line, fontSize)), 0);
  const height = lines.length * fontSize * 1.25;
  return { width, height, lines };
}

export function nodeLabelLayout(label: string): {
  fontSize: number;
  lineHeight: number;
  lines: string[];
  textWidth: number;
  textHeight: number;
  wrapWidth: number;
} {
  const text = measureWrappedText(
    label,
    NODE_LABEL_FONT_SIZE,
    NODE_LABEL_WRAP_WIDTH,
    NODE_LABEL_WIDTH_SAFETY,
  );
  return {
    fontSize: NODE_LABEL_FONT_SIZE,
    lineHeight: NODE_LINE_HEIGHT,
    lines: text.lines,
    textWidth: text.width,
    textHeight: text.height,
    wrapWidth: NODE_LABEL_WRAP_WIDTH,
  };
}

function approxLineWidth(line: string, fontSize: number): number {
  let total = 0;
  for (const ch of line) {
    total += charWidth(ch, fontSize);
  }
  return total;
}

function charWidth(ch: string, fontSize: number): number {
  const code = ch.charCodeAt(0);
  // Narrow chars
  if ('ilftIjI|.,:;\''.includes(ch)) return fontSize * 0.32;
  // Wide chars
  if ('mwWMQ@%'.includes(ch)) return fontSize * 0.85;
  // Digits
  if (code >= 48 && code <= 57) return fontSize * 0.6;
  // Spaces
  if (ch === ' ') return fontSize * 0.3;
  // Default
  return fontSize * INTER_AVG_WIDTH;
}

export function nodeSize(label: string): { width: number; height: number } {
  const text = nodeLabelLayout(label);
  return {
    width: Math.max(
      NODE_MIN_WIDTH,
      Math.ceil(text.textWidth * NODE_LABEL_WIDTH_SAFETY + NODE_ICON_GUTTER + NODE_RIGHT_PADDING),
    ),
    height: Math.max(44, Math.ceil(text.textHeight + NODE_HEIGHT_PADDING)),
  };
}

export function groupTitleSize(title: string): { width: number; height: number } {
  const normalized = title.toUpperCase();
  const text = measureText(normalized, GROUP_TITLE_FONT_SIZE);
  const tracking = Math.max(0, normalized.length - 1) * GROUP_TITLE_LETTER_SPACING;
  return {
    width: Math.ceil(text.width * GROUP_TITLE_TEXT_SAFETY + tracking + GROUP_TITLE_HORIZONTAL_PADDING),
    height: 22,
  };
}

export function edgeLabelSize(label: string): { width: number; height: number } {
  const text = measureText(label, 9.5);
  return {
    width: Math.ceil(text.width + 18),
    height: Math.ceil(text.height + 8),
  };
}
