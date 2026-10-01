import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHtmlMutationFixture } from '../support/html-mutation.mjs';

const fixture = createHtmlMutationFixture();
const normal = await import(pathToFileURL(fixture.root + '/html-body.js').href);
const mutant = await import(pathToFileURL(fixture.mutantPath).href);
const html = '<p>kept<script>alert(1)</script></p>';
assert.doesNotMatch(normal.normalizeHtmlBody(html).html, /<script/);
assert.match(mutant.normalizeHtmlBody(html).html, /<script/);
console.log(JSON.stringify({mirror:fixture.root,mutant:fixture.mutantPath,ordinarySafe:true,mutantUnsafe:true}));
if(process.argv[2]==='interrupt') process.kill(process.pid,'SIGTERM');
else if(process.argv[2]==='timeout') { setInterval(()=>{},1000); await new Promise(()=>{}); }
else throw Error('unknown mutation interruption mode');
