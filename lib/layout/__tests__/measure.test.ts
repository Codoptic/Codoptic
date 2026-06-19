import { describe, expect, it } from 'vitest';
import {
  groupTitleSize,
  measureText,
  measureWrappedText,
  nodeLabelLayout,
  nodeSize,
  wrapText,
} from '../measure';

describe('nodeSize', () => {
  it('reserves enough width for long node labels', () => {
    const label = 'OCR Table Debugger';
    const text = measureText(label, 11);
    const size = nodeSize(label);

    expect(size.width).toBeGreaterThanOrEqual(Math.ceil(text.width * 1.35 + 78));
    expect(size.height).toBeGreaterThanOrEqual(44);
  });

  it('keeps a sensible minimum width for short labels', () => {
    expect(nodeSize('A').width).toBeGreaterThanOrEqual(220);
  });

  it('wraps long labels onto multiple lines', () => {
    const lines = wrapText('Repository Access Review Coordinator', 11, 150, 1.35);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('Repository');
  });

  it('keeps the validator label inside the node text column', () => {
    const layout = nodeLabelLayout('FD Migration Validator');

    expect(layout.lines.length).toBe(2);
    expect(layout.textWidth * 1.35).toBeLessThanOrEqual(layout.wrapWidth);
  });

  it('increases node height when wrapping is required', () => {
    const shortHeight = nodeSize('OCR Table Debugger').height;
    const longHeight = nodeSize('Repository Access Review Coordinator').height;
    const wrapped = measureWrappedText('Repository Access Review Coordinator', 11, 150, 1.35);

    expect(wrapped.lines.length).toBeGreaterThan(1);
    expect(longHeight).toBeGreaterThan(shortHeight);
  });
});

describe('groupTitleSize', () => {
  it('includes icon gutter, tracking, and right padding for rendered titles', () => {
    const title = 'DEVX UTILITIES';
    const text = measureText(title, 10);
    const size = groupTitleSize(title);

    expect(size.width).toBeGreaterThanOrEqual(Math.ceil(text.width * 1.35 + 12 * 0.5 + 78));
    expect(size.height).toBe(22);
  });
});
