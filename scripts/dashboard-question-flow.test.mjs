import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const dashboard = fileURLToPath(new URL('../packages/dashboard/', import.meta.url));

test('operator questions advance individually, preserve answers, and submit together', async () => {
  let server, browser;
  try {
    const result = await build({
      stdin: { resolveDir: dashboard, loader: 'tsx', contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ApprovalPanel} from './src/console/approvals';
        window.responses = [];
        const initial = {id:'questions',kind:'operator-question',title:'A few questions',questions:[
          {header:'Location',question:'Where should it run?',options:[{label:'Local'},{label:'Remote'}],allowCustom:true},
          {header:'Checks',question:'Which checks?',options:[{label:'Source'},{label:'Dependencies'}],multiSelect:true,allowCustom:false}
        ]};
        function App() {
          const [decision,setDecision]=useState(initial); const [busy,setBusy]=useState(false);
          window.setBusy=setBusy; window.replaceDecision=setDecision; window.initial=initial;
          return <ApprovalPanel decision={decision} busy={busy} onResolve={response=>window.responses.push(response)}/>;
        }
        createRoot(document.getElementById('root')).render(<App/>);
      ` },
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@': resolve(dashboard, 'src') }, loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent',
    });
    server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<div id="root"></div><script>${result.outputFiles[0].text}</script>`); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText('Question 1 of 2', {exact:true}).waitFor();
    assert.equal(await page.locator('fieldset').count(), 1);
    assert.equal(await page.getByText('Which checks?', {exact:true}).count(), 0);
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText('Question 1 of 2', {exact:true}).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.responses), []);
    await page.getByRole('radio', {name:'Local', exact:true}).check();
    await page.getByRole('textbox', {name:'Your answer', exact:true}).fill('  Keep it on this machine  ');
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.getByText('Question 2 of 2', {exact:true}).waitFor();
    assert.equal(await page.locator('fieldset').count(), 1);
    assert.equal(await page.getByText('Where should it run?', {exact:true}).count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'checkbox');
    await page.getByRole('button', {name:'Back', exact:true}).click();
    assert.equal(await page.getByRole('radio', {name:'Local', exact:true}).isChecked(), true);
    assert.equal(await page.getByRole('textbox', {name:'Your answer', exact:true}).inputValue(), '  Keep it on this machine  ');
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.getByRole('checkbox', {name:'Source', exact:true}).check();
    await page.getByRole('checkbox', {name:'Dependencies', exact:true}).check();
    await page.evaluate(() => window.setBusy(true));
    await page.locator('form[aria-busy="true"]').waitFor();
    assert.equal(await page.getByRole('button', {name:'Back', exact:true}).isDisabled(), true);
    assert.equal(await page.getByRole('checkbox', {name:'Source', exact:true}).isDisabled(), true);
    await page.evaluate(() => window.setBusy(false));
    await page.getByRole('button', {name:'Send answers', exact:true}).click();
    assert.deepEqual(await page.evaluate(() => window.responses), [{approve:true,answers:[
      {header:'Location',selectedLabels:['Local'],customText:'Keep it on this machine'},
      {header:'Checks',selectedLabels:['Source','Dependencies']}
    ]}]);
    await page.evaluate(() => {window.responses=[];window.replaceDecision({...window.initial,id:'new-question-batch'});});
    await page.getByText('Question 1 of 2', {exact:true}).waitFor();
    assert.equal(await page.getByRole('radio', {name:'Local', exact:true}).isChecked(), false);
    await page.getByRole('button', {name:'Decline', exact:true}).click();
    assert.deepEqual(await page.evaluate(() => window.responses), [{approve:false}]);
    await page.evaluate(() => window.replaceDecision({...window.initial,id:'one-question',questions:window.initial.questions.slice(0,1)}));
    await page.getByRole('button', {name:'Send answers', exact:true}).waitFor();
    assert.equal(await page.getByRole('button', {name:'Next', exact:true}).count(), 0);
    assert.equal(await page.locator('fieldset').count(), 1);
    for (const [approved, label] of [[true, 'Answered'], [false, 'Declined'], [undefined, 'Closed']]) {
      // History remounts the decision with its persisted approval state, not the
      // temporary draft answers held by the pending question form.
      await page.evaluate(({approved, label}) => window.replaceDecision({...window.initial,id:`history-${label}`,resolved:true,approved}), {approved,label});
      await page.getByText('Where should it run?', {exact:true}).waitFor();
      await page.getByText('Which checks?', {exact:true}).waitFor();
      assert.equal(await page.locator('input, textarea, fieldset, button').count(), 0, 'resolved history cannot imply blank unanswered controls');
      await page.getByText(label, {exact:true}).waitFor();
      assert.equal(await page.getByText('Answers are not shown in this view.', {exact:true}).count(), approved ? 1 : 0);
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
