import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const dashboard = fileURLToPath(new URL('../packages/web/', import.meta.url));
test('thread settings show one Scope card: no autonomy select, no confirmation checkboxes, no folder-limit text, and saving never changes the stored mode', async () => {
  let server, browser;
  try {
    const bundle = await build({ stdin: { resolveDir: dashboard, loader: 'tsx', contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MemoryRouter} from 'react-router-dom';
      import {DEFAULT_AUTONOMY_MODE} from '@0/engine/dist/shared/desktop-console.js';
      import {BackendApiContext} from './src/backend-context';
      import {ProjectControl} from './src/components/console-control/system-control';
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      let record={id:'legacy',target:'source:/fixture',role:'audit',autonomyMode:'recon',status:'ready'};
      window.configures=[];window.saves=[];window.defaultMode=DEFAULT_AUTONOMY_MODE;
      const api={configureConsoleSession:async(id,input)=>{window.configures.push({id,input});if(!window.fixtureDeferred)window.setMode(input.autonomyMode);return {session:{id,...input}};},webFetchJson:async(path,init)=>{
        if(path.startsWith('/api/console/project?'))return {path:'/fixture',name:'Fixture',git:{branch:'fixture',dirty:false}};
        if(path.startsWith('/api/console/checks?'))return {checks:[]};
        if(path==='/api/console/sessions/legacy')return {snapshot:{session:record,scopeEnforcement:{enabled:true},scope:{in_scope:[],out_of_scope:[]}}};
        if(path==='/api/console/sessions/legacy/configuration'){const input=JSON.parse(init.body);window.saves.push(input);record={...record,...input};return {session:record};}
        throw Error('Unexpected fixture request '+path);
      }};
      const workspace={perform:async action=>action()};
      function App(){const[mode,setMode]=useState(DEFAULT_AUTONOMY_MODE),[disabled,setDisabled]=useState(false),[deferred,setDeferred]=useState(false),[view,setView]=useState('settings'),[sessionId,setSessionId]=useState(undefined);
        window.setMode=setMode;window.setDisabled=setDisabled;window.setDeferred=setDeferred;window.fixtureDeferred=deferred;
        window.openSettings=id=>{setSessionId(id);setView('settings');};
        return <MemoryRouter><QueryClientProvider client={client}><BackendApiContext.Provider value={api}><ProjectControl key={sessionId??'new'} sessionId={sessionId}/></BackendApiContext.Provider></QueryClientProvider></MemoryRouter>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': resolve(dashboard, 'src') }, loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent' });
    server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await page.evaluate(() => window.defaultMode), 'changes', 'new threads are Can make changes');
    await page.evaluate(() => window.openSettings('legacy'));
    await page.getByText('Scope', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /yolo|recon|observe|propose|asks first|act without asking|ask before acting|autonomy|permissions|limited to|folder and scope reviewed|confirm actions run/i);
    assert.equal(await page.getByRole('combobox', { name: 'Autonomy' }).count(), 0);
    assert.equal(await page.getByRole('checkbox', { name: /reviewed|confirm/i }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => window.saves), [], 'opening settings never writes configuration');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.waitForFunction(() => window.saves.length === 1);
    const saved = (await page.evaluate(() => window.saves))[0];
    assert.equal('autonomyMode' in saved, false, 'saving scope never rewrites the stored mode (legacy recon stays recon)');
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
