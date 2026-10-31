import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dashboard=fileURLToPath(new URL('../packages/dashboard/',import.meta.url));
test('model catalog filters transport providers while maker icons remain real SVG marks',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.model-picker-test-'));
  try{
    const output=resolve(directory,'fixture.mjs');
    await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {ProviderIcon,ModelIcon} from './src/components/provider-icon';export {modelIconProvider} from './src/components/provider-icon';export {filterModels,providerLabel,catalogProviderIds} from './src/components/model-picker';export const renderProvider=id=>renderToStaticMarkup(<ProviderIcon providerId={id}/>);export const renderModel=(model,provider)=>renderToStaticMarkup(<ModelIcon modelId={model} providerId={provider}/>);`,resolveDir:dashboard,loader:'tsx'},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
    const {filterModels,renderProvider,renderModel,modelIconProvider,catalogProviderIds}=await import(pathToFileURL(output).href);
    for(const id of ['azure','chatgpt-plan','chatgpt-codex','openai','anthropic','deepseek','openrouter','z-ai','kimi','qwen','xai','cline','opencode','copilot','google','gemini']){
      const markup=renderProvider(id);
      assert.match(markup,/<svg/,'provider '+id+' must render a real vector logo');
      assert.match(markup,/<path/);
      assert.doesNotMatch(markup,/data-provider-icon="generic"|<span|<text/,'provider '+id+' never uses initials');
    }
    assert.match(renderProvider('unknown-custom-endpoint'),/data-provider-icon="generic"/);
    assert.doesNotMatch(renderProvider('unknown-custom-endpoint'),/>UN</);
    assert.match(renderModel('anthropic/claude-sonnet-4.6','openrouter'),/data-provider-icon="claude"/);
    assert.equal(modelIconProvider('google/gemini-3.1-pro','openrouter'),'gemini');
    assert.equal(modelIconProvider('gpt-5.4','azure'),'openai');
    assert.equal(modelIconProvider('moonshotai/kimi-k2.5','openrouter'),'kimi');
    const models=[{id:'claude-sonnet',provider:'anthropic',source:'public-catalog'},{id:'claude-sonnet',provider:'anthropic',source:'account',contextWindowTokens:200000},{id:'anthropic/claude-sonnet',provider:'openrouter'},{id:'gpt-5.4',provider:'openai'}];
    assert.deepEqual(catalogProviderIds(models,[{providerId:'deepseek'},{providerId:'openai'}]),['anthropic','openrouter','openai','deepseek'],'failed connections remain reachable in the provider rail even with no models');
    assert.equal(filterModels(models,'','').length,3,'duplicate provider/model pairs prefer account metadata');
    assert.equal(filterModels(models,'','')[0].contextWindowTokens,200000);
    assert.deepEqual(filterModels(models,'CLAUDE','openrouter').map(m=>m.provider),['openrouter'],'provider rail filters by connection, not inferred maker');
    assert.deepEqual(filterModels(models,'openai 5.4','').map(m=>m.id),['gpt-5.4']);
    assert.equal(filterModels(models,'no-such-model','').length,0);
    assert.deepEqual(filterModels(models,'Company gateway','',[{id:'openrouter',label:'Company gateway'}]).map(m=>m.provider),['openrouter'],'search includes the actual provider label');
  }finally{await rm(directory,{recursive:true,force:true});}
});
