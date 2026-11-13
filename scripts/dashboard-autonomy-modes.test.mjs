import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const dashboard = fileURLToPath(new URL('../packages/dashboard/', import.meta.url));
test('autonomy controls offer only Standard and YOLO without changing saved legacy modes', async () => {
  let server, browser;
  try {
    const bundle = await build({ stdin: { resolveDir: dashboard, loader: 'tsx', contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MemoryRouter} from 'react-router-dom';
      import {DEFAULT_AUTONOMY_MODE} from '@0/shared/dist/desktop-console.js';
      import {BackendApiContext} from './src/backend-context';import {ModePicker} from './src/console/mode-picker';
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
      function App(){const[mode,setMode]=useState(DEFAULT_AUTONOMY_MODE),[disabled,setDisabled]=useState(false),[deferred,setDeferred]=useState(false),[view,setView]=useState('picker'),[sessionId,setSessionId]=useState(undefined);
        window.setMode=setMode;window.setDisabled=setDisabled;window.setDeferred=setDeferred;window.fixtureDeferred=deferred;
        window.openSettings=id=>{setSessionId(id);setView('settings');};
        return <MemoryRouter><QueryClientProvider client={client}><BackendApiContext.Provider value={api}>{view==='picker'?<ModePicker workspace={workspace} sessionId="fixture" mode={mode} disabled={disabled} deferred={deferred}/>:<ProjectControl key={sessionId??'new'} sessionId={sessionId}/>}</BackendApiContext.Provider></QueryClientProvider></MemoryRouter>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': resolve(dashboard, 'src') }, loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent' });
    server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await page.evaluate(() => window.defaultMode), 'yolo');
    const menuChoices = async () => {
      await page.getByRole('menuitem', { name: /^Standard/ }).waitFor();
      assert.deepEqual((await page.getByRole('menuitem').allTextContents()).map(text => /^(Standard|YOLO)/.exec(text)?.[1] ?? text), ['Standard', 'YOLO']);
    };
    await page.getByRole('button', { name: 'Mode: YOLO', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Standard/ }).waitFor();
    await menuChoices();
    await page.getByRole('menuitem', { name: /^Standard/ }).click();
    await page.getByRole('button', { name: 'Mode: Standard', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.configures), [{ id: 'fixture', input: { autonomyMode: 'standard' } }]);
    await page.getByRole('button', { name: 'Mode: Standard', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Standard/ }).click();
    assert.equal(await page.evaluate(() => window.configures.length), 1, 'choosing the current mode never reconfigures');
    await page.getByRole('button', { name: 'Mode: Standard', exact: true }).click();
    await menuChoices();
    await page.evaluate(() => window.setDisabled(true));
    await page.waitForFunction(() => document.querySelector('[role="menuitem"][aria-disabled="true"]'));
    await page.getByRole('menuitem', { name: /^YOLO/ }).evaluate(item => item.click());
    assert.equal(await page.evaluate(() => window.configures.length), 1, 'an already open menu cannot configure after becoming disabled');
    await page.keyboard.press('Escape');
    const disabled = page.getByRole('button', { name: 'Mode: Standard', exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="Mode: Standard"]')?.disabled);
    assert.equal(await disabled.isDisabled(), true);
    await disabled.evaluate(button => button.click());
    assert.equal(await page.getByRole('menuitem').count(), 0);
    await page.evaluate(() => { window.setDisabled(false); window.setMode('recon'); });
    await page.getByRole('button', { name: 'Mode: Recon', exact: true }).click();
    await menuChoices();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.setMode('copilot'));
    await page.getByRole('button', { name: 'Mode: Auto', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.configures.length), 1, 'loading legacy modes never changes their authority');
    await page.evaluate(() => { window.setMode('yolo'); window.setDeferred(true); });
    await page.getByRole('button', { name: 'Mode: YOLO', exact: true }).click();
    await page.getByText('Changes apply after the current VM turn.', { exact: true }).waitFor();
    await page.getByRole('menuitem', { name: /^Standard/ }).click();
    assert.equal(await page.evaluate(() => window.configures.length), 2);
    await page.getByRole('button', { name: 'Mode: YOLO', exact: true }).waitFor();
    await page.evaluate(() => window.openSettings('legacy'));
    const select = page.getByRole('combobox', { name: 'Autonomy mode', exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="Autonomy mode"]')?.textContent?.includes('Standard'));
    await page.getByText('Saved mode: Recon. The selected mode applies only when you save.', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.saves), []);
    await select.click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Standard', 'YOLO']);
    await page.getByRole('option', { name: 'YOLO', exact: true }).click();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Autonomy mode"]')?.textContent?.includes('Standard'));
    assert.deepEqual(await page.evaluate(() => window.saves), [], 'resetting a legacy draft never applies it');
    await page.getByRole('checkbox', { name: 'I reviewed this target and scope.', exact: true }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => window.saves.length === 1);
    assert.equal((await page.evaluate(() => window.saves))[0].autonomyMode, 'standard');
    await page.evaluate(() => window.openSettings(undefined));
    await page.waitForFunction(() => document.querySelector('[aria-label="Autonomy mode"]')?.textContent?.includes('YOLO'));
    assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.saves.length), 1, 'opening new settings never writes configuration');
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
