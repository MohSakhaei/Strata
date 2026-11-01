// A ```mermaid fence is drawn as a picture; every other fence stays code. The drawing library is asked for only when a fence asks for a picture, and a page with no browser and no library still shows the source.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = file => readFileSync(resolve(root, file), 'utf8');
const run = (code, externals) => build({
  stdin: { contents: code, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['katex', 'katex/dist/katex.min.css', 'mermaid', ...externals],
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /^\.\/ui$/ }, () => ({ path: 'ui', namespace: 'test-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: 'export const IconBtn = () => null; export const Btn = () => null;' }));
  } }],
}).then(built => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return mod.exports;
});

const { isDiagram, diagramTheme } = await run(`export * from './src/lib/diagrams.ts';`, ['react']);
const { html } = await run(`import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { Markdown } from './src/components/Markdown.tsx'; export const html = text => renderToStaticMarkup(React.createElement(Markdown, { text }));`, ['react']);

test('only a fence named mermaid asks for a picture', () => {
  assert.equal(isDiagram('mermaid'), true);
  assert.equal(isDiagram('  mermaid  '), true);
  assert.equal(isDiagram('MERMAID'), true);
  assert.equal(isDiagram('mermaid title=x'), true);
  assert.equal(isDiagram(''), false);
  assert.equal(isDiagram('typescript'), false);
  assert.equal(isDiagram('mermaidjs'), false);
});

test('the picture follows the theme the page is showing', () => {
  assert.equal(diagramTheme('dark'), 'dark');
  assert.equal(diagramTheme('light'), 'default');
  assert.equal(diagramTheme('system'), 'default');
});

test('a diagram fence still gives its source, and nothing is drawn without a browser', () => {
  const out = html('## Flow\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```ts\nconst a = 1;\n```');
  assert.match(out, /<span>mermaid<\/span>/);
  assert.match(out, /A --&gt; B/);
  assert.equal((out.match(/class="syntax-code/g) ?? []).length, 2, 'both fences are code until something draws a picture');
  assert.ok(!out.includes('<svg'), 'a page with no browser draws nothing, so the code block stands');
});

test('the library is only asked for by a diagram, and what it draws is sanitized', () => {
  const markdown = source('src/components/Markdown.tsx');
  const view = source('src/components/DiagramView.tsx');
  assert.match(markdown, /isDiagram\(language\) \? <DiagramView code=\{body\.join\('\\n'\)\} language=\{language\}\/> : <SyntaxCode/);
  assert.ok(!/from 'mermaid'/.test(markdown), 'the page never pulls the drawing library in on its own');
  assert.match(view, /import\('mermaid'\)/);
  assert.match(view, /securityLevel: 'strict'/);
});
