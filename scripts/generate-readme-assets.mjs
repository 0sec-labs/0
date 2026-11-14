// GitHub README artwork: local SVGs, no scripts, remote fonts, or live counters.
// Regenerate with: node scripts/generate-readme-assets.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const out = new URL('../assets/readme/', import.meta.url);
mkdirSync(out, { recursive: true });
const logo = readFileSync(new URL('../assets/0-aperture-white.svg', import.meta.url), 'utf8')
  .replace(/<svg[^>]*>/, '').replace('</svg>', '').trim();
const orange = '#FD802E';
const palettes = {
  dark: { ink: '#F0EEE9', muted: '#9DA5B1', line: '#30363D', panel: '#161B22' },
  light: { ink: '#1F2328', muted: '#59636E', line: '#D1D9E0', panel: '#F6F8FA' },
};
const mono = 'ui-monospace, SFMono-Regular, Consolas, monospace';
function svg(name, width, height, title, content, css = '') {
  writeFileSync(new URL(name + '.svg', out), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title><style>${css}</style>${content}</svg>\n`);
}
function text(x, y, label, color, size = 13, extra = '') {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${mono}" font-size="${size}" ${extra}>${label}</text>`;
}
for (const [theme, p] of Object.entries(palettes)) {
  {
    const suffix = theme;
    svg(`header-${suffix}`, 900, 124, '0security',
      `<g transform="translate(143 27) scale(2.6)">${logo.replaceAll('#FCFAF6', p.ink)}</g>` +
      `<path d="M143 109h614" stroke="${p.line}" stroke-linecap="round"/>` +
      `<path class="loading" d="M143 109h36" stroke="${orange}" stroke-width="2" stroke-linecap="round" opacity="1"/>`,
      '@keyframes loading{0%{transform:translateX(0);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translateX(578px);opacity:0}}.loading{animation:loading 4s ease-in-out infinite}');

  }
  // Buttons follow the site: white primary on dark (inverted on light), opaque secondary.
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const secondary = theme === 'dark'
    ? { fill: '#1B1C1C', stroke: '#FFFFFF', strokeOpacity: '.15', ink: '#F5F4F2' }
    : { fill: '#F6F8FA', stroke: '#D1D9E0', strokeOpacity: '1', ink: '#1F2328' };
  const primary = theme === 'dark' ? { fill: '#FFFFFF', ink: '#0D1117' } : { fill: '#1F2328', ink: '#FFFFFF' };
  const label = (x, y, value, color, anchor = 'middle') =>
    `<text x="${x}" y="${y}" fill="${color}" font-family="${sans}" font-size="15" font-weight="500" text-anchor="${anchor}">${value}</text>`;
  for (const [key, name, width] of [['docs', 'Docs', 96], ['research', 'Research', 120], ['install', 'Install', 104]]) {
    svg(`nav-${key}-${theme}`, width, 48,  name,
      `<rect x="1.5" y="5.5" width="${width - 3}" height="37" rx="10" fill="${secondary.fill}" stroke="${secondary.stroke}" stroke-opacity="${secondary.strokeOpacity}"/>` +
      label(width / 2, 29, name, secondary.ink));
  }
  svg(`enterprise-button-${theme}`, 150, 48, 'Enterprise',
    `<rect x="1" y="5" width="148" height="38" rx="10" fill="${primary.fill}"/>` +
    label(26, 29, 'Enterprise', primary.ink, 'start') +
    `<path d="M114 31l9-9m-8 0h8v8" fill="none" stroke="${primary.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`);
}
console.log('Generated README SVG artwork in assets/readme/');
