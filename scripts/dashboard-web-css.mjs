import {execFile} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
const run=promisify(execFile);
/** The dashboard stylesheet that browser tests render with. Builds packages/web (about 3 s) when no build exists yet, so a fresh checkout needs no prerequisite step. */
export async function webCss(root){
 const web=resolve(root,'packages/web'),assets=resolve(web,'dist/assets');
 const find=async()=>(await readdir(assets).catch(()=>[])).filter(name=>name.endsWith('.css'));
 let files=await find();
 if(!files.length){await run('pnpm',['exec','vite','build'],{cwd:web});files=await find();}
 if(!files.length)throw new Error('packages/web build produced no stylesheet');
 return (await Promise.all(files.map(file=>readFile(resolve(assets,file),'utf8')))).join('\n');
}
