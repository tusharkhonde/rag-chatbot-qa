import type { ReactNode } from 'react';

/**
 * Render LLM output as React elements. The answer is untrusted text (it's shaped by the model AND
 * by document content), so it is NEVER passed to dangerouslySetInnerHTML: a document containing
 * "<img src=x onerror=...>" must show up as text, not execute. React escapes every string child.
 *
 * Supported: paragraphs, "- " / "1. " list lines, `inline code`, **bold**, and citation markers
 * [1] / [1, 2], which become buttons that highlight the matching source.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[\d+(?:\s*,\s*\d+)*\])/g;

export function renderInline(text: string, onCite?: (index: number) => void, keyPrefix = ''): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const [token, code, bold, cite] = match;
    const key = `${keyPrefix}${at}`;
    if (code) nodes.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    else if (cite) {
      for (const n of cite.slice(1, -1).split(',').map((s) => Number(s.trim()))) {
        nodes.push(
          <button key={`${key}-${n}`} type="button" className="cite" onClick={() => onCite?.(n)} aria-label={`Source ${n}`}>
            {n}
          </button>,
        );
      }
    } else nodes.push(token);
    last = at + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function renderAnswer(text: string, onCite?: (index: number) => void): ReactNode[] {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block, b) => {
      const lines = block.split('\n');
      const isList = lines.every((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l));
      if (isList) {
        const ordered = /^\s*\d+\./.test(lines[0]!);
        const items = lines.map((l, i) => <li key={i}>{renderInline(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''), onCite, `${b}-${i}-`)}</li>);
        return ordered ? <ol key={b}>{items}</ol> : <ul key={b}>{items}</ul>;
      }
      return (
        <p key={b}>
          {lines.flatMap((l, i) => (i ? [<br key={`br${i}`} />, ...renderInline(l, onCite, `${b}-${i}-`)] : renderInline(l, onCite, `${b}-${i}-`)))}
        </p>
      );
    });
}
