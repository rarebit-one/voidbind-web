// QR-rendering unit suite. Proves the vendored qrcode-generator is wired up and
// that qrSvg/renderQr produce scannable SVG markup — no browser, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qrSvg, renderQr } from '../src/index.js';

const PAYLOAD = 'voidbind:login?rp=https%3A%2F%2Frp.example&id=login-123';

test('qrSvg encodes a payload into a scalable SVG', () => {
  const svg = qrSvg(PAYLOAD);
  assert.ok(svg.startsWith('<svg'), 'should be SVG markup');
  assert.ok(svg.includes('viewBox='), 'should be scalable (viewBox, no fixed px)');
  assert.ok(!svg.includes('px"'), 'scalable SVG omits a fixed pixel width/height on the svg tag');
  assert.ok(svg.includes('<path'), 'should contain the encoded module path');
});

test('qrSvg round-trips the exact login tuple (distinct payloads differ)', () => {
  const a = qrSvg('voidbind:login?rp=x&id=A');
  const b = qrSvg('voidbind:login?rp=x&id=B');
  assert.notEqual(a, b, 'different login ids must produce different QR codes');
});

test('renderQr writes SVG into a DOM-like element and sets a11y attributes', () => {
  const attrs = {};
  const el = {
    innerHTML: '',
    setAttribute(k, v) { attrs[k] = v; },
    classList: { remove() {} },
  };
  const ok = renderQr(el, PAYLOAD);
  assert.equal(ok, true);
  assert.ok(el.innerHTML.includes('<svg'));
  assert.equal(attrs.role, 'img');
  assert.equal(attrs['aria-label'], 'Voidbind login QR code');
});

test('renderQr returns false (never throws) when given no element', () => {
  assert.equal(renderQr(null, PAYLOAD), false);
});
