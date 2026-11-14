import { describe, expect, it } from 'vitest';
import { userWords } from '../src/lib/messages';
import { withAttached } from '../src/lib/paste';
import { pointedBlock, pointedIn, type Pointed } from '../src/lib/point';

const pay: Pointed = {
  page: 'http://localhost:5199/cart',
  tag: 'button',
  selector: 'main > button#pay',
  text: '去付款',
  box: [40, 120, 180, 52],
  view: [1280, 800],
  style: { color: 'rgb(255, 255, 255)', background: 'rgb(47, 93, 80)', font: '18px 600 system-ui', padding: '1px 6px', margin: '0px', radius: '6px' },
  html: '<button id="pay" class="btn primary">去付款</button>',
  events: [{ ago: 3, kind: 'error', text: 'price is undefined (cart.js:27:14)' }],
};

describe('an element pointed at in the preview', () => {
  it('goes after the words of the message, which stay what the user typed', () => {
    const text = withAttached('这个按钮颜色太暗了', [pointedBlock(pay)], []);
    const m = { id: 'u', role: 'user', origin: 'user', parts: [{ type: 'text', text }], time: 1 } as never;
    expect(userWords(m)).toBe('这个按钮颜色太暗了');
    expect(text).toContain('<element page="http://localhost:5199/cart" selector="main > button#pay" label="button · 去付款">');
    expect(text).toContain('main > button#pay "去付款", 180×52 at (40, 120) in a 1280×800 view');
    expect(text).toContain("the page's last 15 seconds: 3 s before, error: price is undefined (cart.js:27:14)");
    expect(pointedIn(m)).toEqual([{ selector: 'main > button#pay', label: 'button · 去付款' }]);
  });

});

describe('what a previewed page sends', () => {
  it('is checked field by field: a malformed pick is no element, and long fields are cut', async () => {
    const { asPointed } = await import('../src/lib/point');
    expect(asPointed({ page: 'x', tag: 'div', text: {} })).toBeNull();
    expect(asPointed('nope')).toBeNull();
    const p = asPointed({ ...pay, text: 'y'.repeat(5000), events: [{ ago: 1, kind: 'click', text: 'ok' }, { bad: true }] })!;
    expect(p.text).toHaveLength(120);
    expect(p.events).toEqual([{ ago: 1, kind: 'click', text: 'ok' }]);
  });
});
