import { describe, expect, it } from 'vitest';
import { bubbleChains, bubblePath, lineSpans } from '../public/selection-bubble.js';

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

describe('selection bubble geometry', () => {
  it('merges the rects of one visual line into one span', () => {
    expect(
      lineSpans([rect(40, 100, 90, 120), rect(10, 101, 38, 119), rect(10, 124, 200, 144), rect(0, 0, 0, 10)]),
    ).toEqual([
      { l: 10, r: 90, t: 100, b: 120 },
      { l: 10, r: 200, t: 124, b: 144 },
    ]);
  });

  it('joins neighbouring lines, paragraph gaps included, into one bubble', () => {
    const chains = bubbleChains(
      [
        { l: 120, r: 300, t: 100, b: 120 },
        { l: 10, r: 300, t: 124, b: 144 },
        { l: 10, r: 150, t: 160, b: 180 },
      ],
      { padX: 5, padY: 2, radius: 10, maxGap: 48 },
    );
    expect(chains).toHaveLength(1);
    const [lines] = chains;
    // Each line meets the next edge to edge: no seams between them.
    expect(lines[0].b).toBe(lines[1].t);
    expect(lines[1].b).toBe(lines[2].t);
    expect(lines[0].t).toBe(98);
    expect(lines[2].b).toBe(182);
  });

  it('keeps far-apart or side-by-side-less lines as separate bubbles', () => {
    const far = bubbleChains([
      { l: 10, r: 300, t: 100, b: 120 },
      { l: 10, r: 300, t: 200, b: 220 },
    ]);
    expect(far).toHaveLength(2);
    // A line ending left of where the next one starts would only touch at a point.
    const disjoint = bubbleChains([
      { l: 250, r: 300, t: 100, b: 120 },
      { l: 10, r: 60, t: 124, b: 144 },
    ]);
    expect(disjoint).toHaveLength(2);
  });

  it('draws one closed, rounded outline per bubble', () => {
    const one = bubblePath(
      bubbleChains([
        { l: 120, r: 300, t: 100, b: 120 },
        { l: 10, r: 300, t: 124, b: 144 },
      ]),
    );
    expect(one.match(/M/g)).toHaveLength(1);
    expect(one.endsWith('Z')).toBe(true);
    // Every corner is a curve, never a hard right angle.
    expect(one.match(/Q/g)!.length).toBe(one.match(/L/g)!.length + 1);

    const two = bubblePath(
      bubbleChains([
        { l: 10, r: 300, t: 100, b: 120 },
        { l: 10, r: 300, t: 200, b: 220 },
      ]),
    );
    expect(two.match(/M/g)).toHaveLength(2);
    expect(bubblePath([])).toBe('');
  });
});
