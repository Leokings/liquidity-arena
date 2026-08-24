import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

function colorToken(name) {
  const match = styles.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `${name} must be a six-digit hex color`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test('secondary text tokens remain readable across the darkest and raised UI surfaces', () => {
  const textTokens = ['--muted', '--faint', '--disabled', '--soft-lime', '--soft-danger'];
  const surfaces = ['#060812', '#08120f', '#202a23'];

  for (const token of textTokens) {
    const foreground = colorToken(token);
    for (const background of surfaces) {
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= 4.5, `${token} contrast ${ratio.toFixed(2)} is below 4.5:1 on ${background}`);
    }
  }
});

test('tiny labels no longer use the legacy low-contrast colors', () => {
  const legacyLowContrastColors = [
    '#4d5c55',
    '#60736a',
    '#3e4c45',
    '#64766c',
    '#59675f',
    '#647064',
  ];

  for (const color of legacyLowContrastColors) {
    assert.doesNotMatch(styles, new RegExp(color, 'i'), `${color} must not be used for UI text`);
  }
});

test('unavailable controls stay visually distinct without hiding their labels', () => {
  assert.match(styles, /\.battle-objective-controls button:disabled\s*\{[^}]*opacity:\s*0\.75;/s);
  assert.match(styles, /\.prediction-option\.unavailable\s*\{[^}]*opacity:\s*0\.75;/s);
  assert.match(styles, /\.prediction-cta:disabled\s*\{[^}]*opacity:\s*0\.72;/s);
  assert.match(styles, /\.load-more-positions:disabled\s*\{[^}]*color:\s*var\(--disabled\);[^}]*opacity:\s*1;/s);
});
