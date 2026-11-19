import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {join,extname} from 'node:path';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const assets={};
function collect(dir,prefix=''){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='server'||entry.name.startsWith('.'))continue;
    const path=join(dir,entry.name),name=prefix+'/'+entry.name;
    if(entry.isDirectory())collect(path,name);
    else assets[name]={body:readFileSync(path,'utf8'),type:({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.md':'text/markdown; charset=utf-8'})[extname(entry.name)]||'text/plain; charset=utf-8'};
  }
}
collect(join(root,'dist'));
writeFileSync(join(root,'worker/assets.generated.mjs'),'export const assets='+JSON.stringify(assets)+';\nexport const runnerSource='+JSON.stringify(readFileSync(join(root,'platform/runner.mjs'),'utf8'))+';\n');
mkdirSync(join(root,'dist/server'),{recursive:true});
await build({entryPoints:[join(root,'worker/index.mjs')],outfile:join(root,'dist/server/index.js'),bundle:true,format:'esm',platform:'browser',target:'es2023',minify:false});
if(existsSync(join(root,'.openai/hosting.json'))){
 mkdirSync(join(root,'dist/.openai'),{recursive:true});
 writeFileSync(join(root,'dist/.openai/hosting.json'),readFileSync(join(root,'.openai/hosting.json')));
}
console.log('Built Connector workbench and preserved Landing page');
