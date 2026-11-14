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
  for (const [key,label,width] of [['docs','DOCS',82],['research','RESEARCH',116],['install','INSTALL',104]]) {
    svg(`nav-${key}-${theme}`,width,48,label,text(width/2,29,label,p.muted,13,'text-anchor="middle" letter-spacing="1"'));
  }
}
svg('enterprise-button', 188, 48, 'Enterprise',
  `<rect x="2" y="2" width="184" height="44" rx="9" fill="${orange}"/>` +
  text(20, 30, 'ENTERPRISE', '#FFFFFF', 14, 'font-weight="700" letter-spacing="1"') +
  '<path d="M158 30l10-10m-9 0h9v9" fill="none" stroke="#FFFFFF" stroke-width="1.5"/>');
console.log('Generated README SVG artwork in assets/readme/');
