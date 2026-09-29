import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderAnswer } from '../../client/src/lib/renderAnswer';

const html = (text: string) => renderToStaticMarkup(<>{renderAnswer(text)}</>);

describe('renderAnswer', () => {
  it('turns citation markers into buttons, and code/bold into elements', () => {
    const out = html('Run `launchpad rollback` **now** [1][2, 3].');
    expect(out).toContain('<code>launchpad rollback</code>');
    expect(out).toContain('<strong>now</strong>');
    expect(out.match(/class="cite"/g)).toHaveLength(3);
  });

  it('renders HTML in model output as inert text (no XSS)', () => {
    const out = html('Hello <img src=x onerror=alert(1)> and <script>alert(2)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders paragraphs and lists', () => {
    const out = html('Steps:\n\n1. Check lag [1]\n2. Move the message\n\nDone.');
    expect(out).toMatch(/^<p>Steps:<\/p><ol><li>Check lag <button[^>]*>1<\/button><\/li><li>Move the message<\/li><\/ol><p>Done.<\/p>$/);
  });
});
