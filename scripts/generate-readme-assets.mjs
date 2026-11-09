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
const sans = '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
function svg(name, width, height, title, content, css = '') {
  writeFileSync(new URL(name + '.svg', out), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title><style>${css}</style>${content}</svg>\n`);
}
function text(x, y, label, color, size = 13, extra = '') {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${mono}" font-size="${size}" ${extra}>${label}</text>`;
}
for (const [theme, p] of Object.entries(palettes)) {
  for (const still of [false, true]) {
    const suffix = theme + (still ? '-static' : '');
    svg(`header-${suffix}`, 900, 124, '0security',
      `<g transform="translate(143 27) scale(2.6)">${logo.replaceAll('#FCFAF6', p.ink)}</g>` +
      `<path d="M143 109h614" stroke="${p.line}" stroke-linecap="round"/>` +
      `<path class="loading" d="M143 109h36" stroke="${orange}" stroke-width="2" stroke-linecap="round" opacity="${still ? '0' : '1'}"/>`,
      still ? '' : '@keyframes loading{0%{transform:translateX(0);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translateX(578px);opacity:0}}.loading{animation:loading 4s ease-in-out infinite}@media(prefers-reduced-motion:reduce){.loading{animation:none;opacity:0}}');
    for (const mobile of [false, true]) {
      const w = mobile ? 420 : 900, h = mobile ? 234 : 94;
      const xs = mobile ? [20, 20, 20] : [20, 322, 624];
      const ys = mobile ? [10, 88, 166] : [12, 12, 12];
      const labels = ['PULL REQUEST', 'SECURITY REVIEW', 'AUTOFIX'];
      const subtitles = ['Connect your GitHub repository', 'Scan, investigate, test', 'Review and apply fixes in the same PR'];
      let content = '';
      for (let i = 0; i < 3; i++) {
        const x=xs[i], y=ys[i], bw=mobile?380:256, bh=mobile?58:66;
        content += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8" fill="${p.panel}" stroke="${p.line}"/>`;
        content += text(x+16,y+24,`0${i+1}`,orange,11) + text(x+48,y+24,labels[i],p.ink,12,'font-weight="600"');
        content += `<text x="${x+16}" y="${y+46}" fill="${p.muted}" font-family="${sans}" font-size="13">${subtitles[i]}</text>`;
        if (i<2) content += mobile ? `<path d="M210 ${y+bh+3}v17m-4-4 4 4 4-4" fill="none" stroke="${p.muted}"/>` : `<path d="M${x+bw+10} 45h26m-5-4 5 4-5 4" fill="none" stroke="${p.muted}"/>`;
        content += `<rect class="phase phase-${i}" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8" fill="none" stroke="${orange}" opacity="${still ? '.5' : '0'}"/>`;
      }
      const animation = still ? '' : '@keyframes phase{0%,30%,100%{opacity:0}5%,25%{opacity:.85}}.phase{animation:phase 9s ease-in-out infinite}.phase-1{animation-delay:3s}.phase-2{animation-delay:6s}@media(prefers-reduced-motion:reduce){.phase{animation:none;opacity:.5}}';
      svg(`cloud-flow-${mobile?'mobile-':''}${suffix}`,w,h,'0cloud: connect a pull request, investigate security issues, review and apply fixes',content,animation);
    }
  }
  for (const [key,label,width] of [['docs','DOCS',82],['research','RESEARCH',116],['install','INSTALL',104]]) {
    svg(`nav-${key}-${theme}`,width,48,label,text(width/2,29,label,p.muted,13,'text-anchor="middle" letter-spacing="1"'));
  }
}
for (const still of [false, true]) {
  svg(`cloud-button${still ? '-static' : ''}`, 164, 48, '0cloud — sign up with GitHub',
    `<rect x="2" y="2" width="160" height="44" rx="9" fill="${orange}"/>` +
    '<rect class="border" x="3" y="3" width="158" height="42" rx="8" fill="none" stroke="#FFFFFF" stroke-width="1.4" pathLength="100" stroke-dasharray="15 85" opacity=".85"/>' +
    text(24, 30, '0CLOUD', '#FFFFFF', 14, 'font-weight="700" letter-spacing="1"') +
    '<path d="M128 30l10-10m-9 0h9v9" fill="none" stroke="#FFFFFF" stroke-width="1.5"/>',
    still ? '.border{opacity:0}' : '@keyframes border{to{stroke-dashoffset:-100}}.border{animation:border 5s linear infinite}@media(prefers-reduced-motion:reduce){.border{animation:none;opacity:0}}');
}
console.log('Generated README SVG artwork in assets/readme/');
