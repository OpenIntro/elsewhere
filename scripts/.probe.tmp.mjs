import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 640 } }); const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start');
await p.goto('http://localhost:2601/?autojoin=1');
while (true) { const s = await p.evaluate(() => window.__ELSEWHERE__?.snapshot?.()?.connection); if (s==='connected') break; await new Promise(r=>setTimeout(r,100)); }
const { profile } = await cdp.send('Profiler.stop');
const { SourceMapConsumer } = createRequire(import.meta.url)('source-map-js');
const maps = {};
function name(n){ const f=n.callFrame; const file=f.url.split('/').pop(); if (file.endsWith('.js')) { maps[file] ??= new SourceMapConsumer(JSON.parse(fs.readFileSync('client/dist/assets/'+file+'.map','utf8'))); const o = maps[file].originalPositionFor({line:f.lineNumber+1, column:f.columnNumber}); if (o.source) return `${o.name||f.functionName} ${o.source.replace(/.*\/src\//,'').replace(/.*node_modules\//,'nm/')}:${o.line}`; } return `${f.functionName||'(anon)'} ${file}:${f.lineNumber}`; }
const byId = new Map(profile.nodes.map(n=>[n.id,n]));
const self = new Map(); const dt = profile.timeDeltas; 
const counts = new Map(); for (const s of profile.samples) counts.set(s,(counts.get(s)??0)+1);
// self time by function
const agg = new Map();
for (const [id,c] of counts) { const n = byId.get(id); const k = name(n); agg.set(k,(agg.get(k)??0)+c); }
console.log([...agg].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([k,v])=>`${v}ms ${k}`).join('\n'));
// inclusive time: parent map
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children??[]) parent.set(c, n.id);
const incl = new Map();
for (const [id,c] of counts) { const seen=new Set(); let x=id; while (x!==undefined){ const n=byId.get(x); const k=name(n); if(!seen.has(k)){seen.add(k); incl.set(k,(incl.get(k)??0)+c);} x=parent.get(x);} }
console.log('--- inclusive'); console.log([...incl].sort((a,b)=>b[1]-a[1]).slice(0,45).map(([k,v])=>`${v}ms ${k}`).join('\n'));
await browser.close();
