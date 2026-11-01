import { useEffect, useState } from 'react';
import { SyntaxCode } from './SyntaxCode';
import { diagramTheme, useDiagramTheme } from '../lib/diagrams';

/**
 * A diagram fence, drawn.
 *
 * The code is shown straight away and the drawing takes its place when it is ready: the
 * block never goes empty, and a diagram the library cannot draw (a typo in the source, or
 * no drawing library at all) is simply the code, which is what such a fence looked like before.
 *
 * The library itself is loaded on demand, like math: a chat with no diagram in it never
 * asks for it, so nothing is paid for the fences that are not diagrams.
 */
let taken = 0;

export function DiagramView({ code, language = 'mermaid' }: { code: string; language?: string }) {
    const theme = useDiagramTheme();
    const [drawn, setDrawn] = useState('');
    useEffect(() => {
        let live = true;
        const id = `strata-diagram-${++taken}`;
        setDrawn('');
        import('mermaid').then(({ default: mermaid }) => {
            mermaid.initialize({
                startOnLoad: false,
                // The source can come from a model or from a file on disk, so the drawing is
                // sanitized and cannot run anything: no click handlers, no embedded scripts.
                securityLevel: 'strict',
                theme: diagramTheme(theme),
                fontFamily: 'inherit',
            });
            return mermaid.render(id, code);
        }).then(result => {
            if (live) setDrawn(result.svg);
        }).catch(() => {
            if (live) setDrawn('');
        });
        return () => {
            live = false;
            // The library leaves its working copy behind when a drawing goes wrong.
            document.getElementById(`d${id}`)?.remove();
        };
    }, [code, theme]);
    if (!drawn)
        return <SyntaxCode text={code} language={language}/>;
    return <div className="md-diagram" dangerouslySetInnerHTML={{ __html: drawn }}/>;
}
