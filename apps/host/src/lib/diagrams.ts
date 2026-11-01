import { useSyncExternalStore } from 'react';

/**
 * Fences that ask for a picture rather than for code. The name is the whole rule:
 * a ```mermaid block holds diagram source, and every other fence stays code.
 */
export const isDiagram = (language: string): boolean => /^mermaid(\s|$)/i.test(String(language ?? '').trim());

/** The palette the drawing library should use for the theme the page is showing. */
export const diagramTheme = (theme: string): 'dark' | 'default' => (theme === 'dark' ? 'dark' : 'default');

/**
 * The theme as the page has it right now, and again whenever it changes.
 * The app writes it onto `<html data-theme>` (store.ts), so watching that attribute
 * follows a hand-picked theme and a system one alike without knowing about the store.
 */
const watchers = new Set<() => void>();
let watching: MutationObserver | undefined;

function watchTheme(notify: () => void): () => void {
  watchers.add(notify);
  if (!watching && typeof MutationObserver === 'function') {
    watching = new MutationObserver(() => watchers.forEach(watch => watch()));
    watching.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return () => {
    watchers.delete(notify);
    if (!watchers.size && watching) {
      watching.disconnect();
      watching = undefined;
    }
  };
}

const themeNow = (): string => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function useDiagramTheme(): string {
  return useSyncExternalStore(watchTheme, themeNow, () => 'light');
}
