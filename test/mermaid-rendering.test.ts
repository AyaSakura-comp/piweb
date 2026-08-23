import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JAPANESE_MERMAID_PALETTE,
  getMermaidConfig,
  getMermaidDiagramLabel,
} from '../public/markdown.js';

const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

describe('Mermaid rendering configuration', () => {
  it('labels a Gantt diagram as Gantt instead of Flowchart', () => {
    expect(getMermaidDiagramLabel('gantt\n  title Release plan')).toBe('Gantt');
    expect(getMermaidDiagramLabel('flowchart LR\n  A --> B')).toBe('Flowchart');
    expect(getMermaidDiagramLabel('stateDiagram-v2\n  [*] --> Ready')).toBe('State');
  });

  it('gives Gantt diagrams a readable canvas instead of sizing them to a phone viewport', () => {
    const config = getMermaidConfig();

    expect(config.gantt.useMaxWidth).toBe(false);
    expect(config.gantt.useWidth).toBeGreaterThanOrEqual(900);
    expect(config.gantt.leftPadding).toBeGreaterThanOrEqual(180);
    expect(config.gantt.fontSize).toBeGreaterThanOrEqual(12);
  });

  it('starts oversized diagrams at their left edge so no content is unreachable', () => {
    const scrollRule = css.match(/\.mermaid-scroll\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(scrollRule).toContain('justify-content: flex-start');
    expect(scrollRule).not.toContain('justify-content: center');
  });

  it('uses one Japanese palette across pie, class, state, sequence and Git charts', () => {
    const { themeVariables } = getMermaidConfig();

    expect(themeVariables.background).toBe('#1c1c1a');
    expect(themeVariables.primaryColor).toBe(JAPANESE_MERMAID_PALETTE[0]);
    expect(themeVariables.secondaryColor).toBe(JAPANESE_MERMAID_PALETTE[1]);
    expect(themeVariables.tertiaryColor).toBe(JAPANESE_MERMAID_PALETTE[2]);
    expect(Array.from({ length: 12 }, (_, i) => themeVariables[`pie${i + 1}`])).toEqual(
      JAPANESE_MERMAID_PALETTE
    );
    expect(Array.from({ length: 12 }, (_, i) => themeVariables[`cScale${i}`])).toEqual(
      JAPANESE_MERMAID_PALETTE
    );
    expect(Array.from({ length: 8 }, (_, i) => themeVariables[`git${i}`])).toEqual(
      JAPANESE_MERMAID_PALETTE.slice(0, 8)
    );
    expect(themeVariables.actorBkg).toBe(JAPANESE_MERMAID_PALETTE[1]);
    expect(themeVariables.stateBkg).toBe(JAPANESE_MERMAID_PALETTE[0]);
    expect(themeVariables.taskTextColor).toBe('#f4f0e6');
  });
});
