import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as markdown from '../public/markdown.js';

const publicDir = resolve(import.meta.dirname, '../public');

type HighlightResult = { value: string; language?: string };
type Highlighter = {
  getLanguage?: (language: string) => unknown;
  highlight?: (source: string, options: { language: string; ignoreIllegals: boolean }) => HighlightResult;
  highlightAuto: (source: string) => HighlightResult;
};
type HighlightCode = (
  code: string,
  language: string,
  highlighter: Highlighter,
) => HighlightResult | undefined;
type CodeElement = {
  classList: { add: (...tokens: string[]) => void };
  dataset: Record<string, string>;
  innerHTML: string;
};
type ApplySyntaxHighlighting = (
  element: CodeElement,
  code: string,
  language: string,
  highlighter: Highlighter,
) => boolean;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  className = '';
  innerHTML = '';
  textContent = '';
  readonly classList = {
    add: (...tokens: string[]) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      tokens.forEach((token) => classes.add(token));
      this.className = [...classes].join(' ');
    },
  };

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
}

describe('code block syntax highlighting', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('auto-detects the language when a fenced code block has no language tag', () => {
    const highlightAuto = vi.fn(() => ({
      value: '<span class="hljs-keyword">const</span> answer = 42;',
      language: 'javascript',
    }));
    const highlightCode = (markdown as unknown as { highlightCode: HighlightCode }).highlightCode;

    const result = highlightCode('const answer = 42;', '', { highlightAuto });

    expect(highlightAuto).toHaveBeenCalledWith('const answer = 42;');
    expect(result?.language).toBe('javascript');
  });

  it('uses the declared language when the fenced code block names a supported language', () => {
    const highlight = vi.fn(() => ({
      value: '<span class="hljs-keyword">SELECT</span> * FROM messages;',
      language: 'sql',
    }));
    const highlightAuto = vi.fn(() => ({ value: '', language: 'plaintext' }));
    const highlighter = {
      getLanguage: vi.fn((language: string) => language === 'sql'),
      highlight,
      highlightAuto,
    };
    const highlightCode = (markdown as unknown as { highlightCode: HighlightCode }).highlightCode;

    const result = highlightCode('SELECT * FROM messages;', 'sql', highlighter);

    expect(highlight).toHaveBeenCalledWith('SELECT * FROM messages;', {
      language: 'sql',
      ignoreIllegals: true,
    });
    expect(highlightAuto).not.toHaveBeenCalled();
    expect(result?.language).toBe('sql');
  });

  it('falls back to auto-detection when a declared language is not supported', () => {
    const highlightAuto = vi.fn(() => ({
      value: '<span class="hljs-string">custom syntax</span>',
      language: 'ruby',
    }));
    const highlighter = {
      getLanguage: vi.fn(() => undefined),
      highlight: vi.fn(),
      highlightAuto,
    };
    const highlightCode = (markdown as unknown as { highlightCode: HighlightCode }).highlightCode;

    const result = highlightCode('custom syntax', 'made-up-lang', highlighter);

    expect(highlightAuto).toHaveBeenCalledWith('custom syntax');
    expect(result?.language).toBe('ruby');
  });

  it('applies highlighted markup and the detected language to a code element', () => {
    const add = vi.fn();
    const element: CodeElement = { classList: { add }, dataset: {}, innerHTML: '' };
    const highlighter = {
      highlightAuto: vi.fn(() => ({
        value: '<span class="hljs-keyword">const</span> answer = 42;',
        language: 'javascript',
      })),
    };
    const applySyntaxHighlighting = (
      markdown as unknown as { applySyntaxHighlighting: ApplySyntaxHighlighting }
    ).applySyntaxHighlighting;

    const applied = applySyntaxHighlighting(element, 'const answer = 42;', '', highlighter);

    expect(applied).toBe(true);
    expect(element.innerHTML).toContain('hljs-keyword');
    expect(add).toHaveBeenCalledWith('hljs');
    expect(add).toHaveBeenCalledWith('language-javascript');
    expect(element.dataset.language).toBe('javascript');
  });

  it('highlights fenced code blocks rendered into the transcript', () => {
    const highlightAuto = vi.fn(() => ({
      value: '<span class="hljs-keyword">const</span> answer = 42;',
      language: 'javascript',
    }));
    vi.stubGlobal('window', { hljs: { highlightAuto } });
    vi.stubGlobal('document', {
      createElement: (tagName: string) => new FakeElement(tagName),
      createTextNode: (text: string) => Object.assign(new FakeElement('#text'), { textContent: text }),
    });
    const container = new FakeElement('div');

    markdown.renderRich(
      container as unknown as HTMLElement,
      '```\nconst answer = 42;\n```',
    );

    const code = container.children[0]?.children[0];
    expect(code?.tagName).toBe('code');
    expect(code?.innerHTML).toContain('hljs-keyword');
    expect(code?.className).toContain('hljs');
  });

  it('loads the vendored highlighter before the app renders any messages', () => {
    const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
    const highlighterScript = '/vendor/highlight/highlight.min.js';

    expect(existsSync(resolve(publicDir, 'vendor/highlight/highlight.min.js'))).toBe(true);
    expect(html).toContain(`<script src="${highlighterScript}"></script>`);
    expect(html.indexOf(highlighterScript)).toBeLessThan(html.indexOf('/app.js'));
  });

  it('visually distinguishes common syntax tokens in the dark transcript theme', () => {
    const css = readFileSync(resolve(publicDir, 'app.css'), 'utf8');

    expect(css).toMatch(/\.hljs-keyword[\s\S]*?color:/);
    expect(css).toMatch(/\.hljs-string[\s\S]*?color:/);
    expect(css).toMatch(/\.hljs-comment[\s\S]*?color:/);
  });
});
