import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../dist/server/index.js',import.meta.url),'utf8');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
for(const path of ['/','/app','/app/workbench.js','/project-sources.html']){
 const response=await worker.fetch(new Request('https://example.test'+path),{});assert.equal(response.status,200,path);
}
assert.equal((await worker.fetch(new Request('https://example.test/missing'),{})).status,404);
console.log('Worker artifact serves Landing page and Connector workbench');
