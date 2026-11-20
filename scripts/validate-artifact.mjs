import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../dist/server/index.js',import.meta.url),'utf8');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
for(const path of ['/','/app','/invite','/invite/invite.js','/app/workbench.js','/assets/getting-started.md','/project-sources.html']){
 const response=await worker.fetch(new Request('https://example.test'+path),{});assert.equal(response.status,200,path);
}
assert.equal((await worker.fetch(new Request('https://example.test/missing'),{})).status,404);
const moved=await worker.fetch(new Request('https://beta.example/invite#private'),{PA_AUTH_MODE:'github',PA_ORIGIN:'https://example.test'});assert.equal(moved.status,307);assert.equal(moved.headers.get('location'),'https://example.test/invite');
console.log('Worker artifact serves Landing page, invitations and Connector workbench');
