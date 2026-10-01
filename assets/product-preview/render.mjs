// Render composed product plates from intact public web-app captures.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const font = await readFile(resolve(here, 'geist.woff2'));
const browser = await chromium.launch({ headless: true });
try {
  for (const plate of [
    {id:'chat', index:'01', title:'Ask Zero. Inspect the evidence.', subtitle:'Source review in your workspace.', file:'web-chat.jpg'},
    {id:'workflow', index:'02', title:'Turn the plan into a workflow.', subtitle:'Reusable steps. Explicit targets. Retained runs.', file:'web-workflow.jpg'},
  ]) {
    const source = await readFile(resolve(here, '../screenshots', plate.file));
    const page = await browser.newPage({ viewport: { width: 1920, height: 1480 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font.toString('base64')})}*{box-sizing:border-box}body{margin:0;background:#f7f5f2;color:#1a1815;font-family:Geist}main{padding:70px 76px 44px}.eyebrow{font-size:22px;color:#706c66;display:flex;gap:16px;align-items:center}.number{color:#a7470b;font-weight:600}h1{font-size:68px;letter-spacing:-3px;line-height:1.1;font-weight:600;margin:24px 0 18px}p{font-size:28px;color:#706c66;margin:0 0 40px}.screen{display:block;width:100%;height:auto;border-radius:24px}.foot{display:flex;justify-content:space-between;margin-top:28px;font-size:22px;color:#706c66}.foot strong{color:#403d39;font-weight:500}</style><main><div class="eyebrow"><span class="number">${plate.index}</span><span>ZERO / WEB APP</span></div><h1>${plate.title}</h1><p>${plate.subtitle}</p><img class="screen" src="data:image/jpeg;base64,${source.toString('base64')}" /><div class="foot"><strong>Local demo API review</strong><span>Open source · 0.security</span></div></main>`);
    await page.evaluate(()=>document.fonts.ready);
    await page.locator('.screen').evaluate(i=>i.decode());
    await page.locator('main').screenshot({path:resolve(here,`${plate.id}.png`)});
    await page.close();
  }
} finally { await browser.close(); }
