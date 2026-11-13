const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { chromium } = require('playwright');
const path = require('node:path');
const revision = 'working tree';
const source = fs.readFileSync(path.join(__dirname, '../via-location-mask.user.js'), 'utf8');
// This release targets six API coverage gaps. Compare existing Date behavior
// against v1.0.4 by default; --native-dates audits outstanding native parity gaps.
const nativeDates = process.argv.includes('--native-dates');
const baseline = nativeDates ? null : execFileSync('git', ['show',
  'c8c25c0:via-location-mask.user.js'], {cwd:path.join(__dirname,'..'),encoding:'utf8'});
const config = { enabled:true, timezoneEnabled:true, timezone:'Asia/Tokyo', localeEnabled:true,
  language:'ja-JP', languages:['ja-JP','en-US'], workerEnabled:true, patchUrlWorkers:true };
// Emulate the synchronous script-scoped store shared across all injections.
const token = '1234567890abcdef1234567890abcdef';
function installSource(zone = 'Asia/Tokyo', script = source) {
  return `(() => {
    let storeOwner;
    try { void top.__reviewStore; storeOwner = top; } catch (_) { storeOwner = globalThis; }
    const saved = storeOwner.__reviewStore || (storeOwner.__reviewStore = new Map([['via-location-mask.instance-token.v1', '${token}'],
      ['via-location-mask.settings.v1', ${JSON.stringify({...config,timezone:zone})}]]));
    const GM_getValue = (key, fallback) => saved.has(key) ? saved.get(key) : fallback;
    const GM_setValue = (key,value) => saved.set(key,value);
    ${script}
  })();`;
}
const dates = [0,-1,Date.UTC(2024,0,15),Date.UTC(2024,6,15),Date.UTC(1900,0,1),
 Date.UTC(1940,0,1),Date.UTC(1950,6,1),Date.UTC(1960,0,1),Date.UTC(1960,6,1),
 Date.UTC(1975,0,1),Date.UTC(1975,6,1),Date.UTC(1990,0,1),Date.UTC(1990,6,1),
 Date.UTC(2000,0,1),Date.UTC(2000,6,1),Date.UTC(2012,2,15),Date.UTC(2015,0,1),Date.UTC(2015,6,1),
 Date.UTC(2026,0,1),Date.UTC(2026,2,15),Date.UTC(2026,6,1),Date.UTC(2026,9,1),
 Date.UTC(2039,0,1),Date.UTC(2039,6,1),Date.UTC(2100,0,1),Date.UTC(2100,6,1),
 -62167219200000,-62198755200000,-59042995200000];
function dateProbe(stamps) {
 return stamps.map(t => { const d = new Date(t); try { return [t,d.toString(),d.toDateString(),d.toTimeString(),d.getTimezoneOffset()]; }
 catch(e) { return [t, e.name+': '+e.message]; } });
}
async function worker(page, code) {
 return page.evaluate(code => new Promise((resolve,reject) => {
   const u=URL.createObjectURL(new Blob([code],{type:'text/javascript'})), w=new Worker(u);
   const timer=setTimeout(()=>{w.terminate();reject(Error('timeout'));},5000);
   const close=()=>{clearTimeout(timer);w.terminate();URL.revokeObjectURL(u)};
   w.onmessage=e=>{close();resolve(e.data)}; w.onerror=e=>{close();reject(Error(e.message))};
 }),code);
}
let browser,server; let failures=0,checks=0;
async function check(name,fn) {checks++;try{await fn();console.log('PASS '+name)}catch(e){failures++;console.log('FAIL '+name+' '+e.message.slice(0,1400))}}
(async()=>{
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>Review</body>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH ? {executablePath:process.env.BROWSER_PATH} : {})});
 console.log('Review '+revision+'; browser '+browser.version());
 for(const childFirst of [false,true]) {
  await check('Independent injection, childFirst='+childFirst,async()=>{
   const ctx=await browser.newContext({timezoneId:'America/New_York',locale:'en-US'});
   try{
    const p=await ctx.newPage();await p.goto(origin);
    if(!childFirst) await p.evaluate(installSource());
    await p.evaluate(()=>new Promise(r=>{const f=document.createElement('iframe');f.id='child';f.onload=r;f.src='/child';document.body.append(f)}));
    const f=p.frames().find(x=>x.parentFrame()); await f.evaluate(installSource());
    if(childFirst) await p.evaluate(installSource());
    const r=await p.evaluate(()=>{const w=document.getElementById('child').contentWindow;return {
     fromParent:Function.prototype.toString.call(w.Date), fromChild:w.Function.prototype.toString.call(Date),
     hour:new w.Date(0).getHours()}});
    console.log('FRAME '+JSON.stringify({childFirst,hour:r.hour,parentNative:r.fromParent.includes('[native code]'),childNative:r.fromChild.includes('[native code]')}));
    assert.match(r.fromParent,/\[native code\]/);assert.match(r.fromChild,/\[native code\]/);assert.equal(r.hour,9);
   }finally{await ctx.close()}
  });
 }
 await check('Same-document reinjection must not hand secret to webpage hook',async()=>{
  const ctx=await browser.newContext({locale:'en-US'});try{
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   await p.evaluate(()=>{const original=Function.prototype.toString; Function.prototype.toString=function(...args){
    const result=Reflect.apply(original,this,args);if(args.length && result && typeof result==='object') globalThis.leakedState=result;
    return result;
   }});
   await p.evaluate(installSource());
   const leaked=await p.evaluate(()=>{
    const state=globalThis.leakedState;
    if(!state?.names)return {leaked:false};
    const before=Date.toString();
    const unmasked=Reflect.apply(state.nativeToString,Date,[]);
    state.names.delete(Date);
    return {leaked:true,beforeNative:before.includes('[native code]'),
      exposesSource:unmasked.includes('const args'),afterNative:Date.toString().includes('[native code]')};
   });
   console.log('STATE_PROBE '+JSON.stringify(leaked));
   assert.equal(leaked.leaked,false);
  }finally{await ctx.close()}
 });
 await check('Parent-patched child owns iframe accessor wrappers after independent injection',async()=>{
  const ctx=await browser.newContext({locale:'en-US',timezoneId:'America/New_York'});
  try {
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   await p.evaluate(()=>new Promise(r=>{const f=document.createElement('iframe');f.id='child';f.onload=r;f.src='/child';document.body.append(f)}));
   const f=p.frames().find(x=>x.parentFrame());await f.evaluate(installSource());
   const result=await f.evaluate(()=>{
    const getter=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow').get;
    return {self:Function.prototype.toString.call(getter),parent:parent.Function.prototype.toString.call(getter)};
   });
   console.log('ACCESSOR '+JSON.stringify(result));
   assert.match(result.self,/\[native code\]/);assert.match(result.parent,/\[native code\]/);
  }finally{await ctx.close()}
 });
 await check('Siblings independently injected before parent: cross-realm Date masks',async()=>{
  const ctx=await browser.newContext({locale:'en-US',timezoneId:'America/New_York'});
  try {
   const p=await ctx.newPage();await p.goto(origin);
   await p.evaluate(async()=>{for(const id of ['a','b'])await new Promise(r=>{
    const f=document.createElement('iframe');f.id=id;f.onload=r;f.src='/'+id;document.body.append(f);
   })});
   for(const f of p.frames().filter(x=>x.parentFrame()))await f.evaluate(installSource());
   await p.evaluate(installSource());
   const result=await p.evaluate(()=>{
    const a=document.getElementById('a').contentWindow,b=document.getElementById('b').contentWindow;
    return {ab:a.Function.prototype.toString.call(b.Date),ba:b.Function.prototype.toString.call(a.Date)};
   });
   console.log('SIBLING '+JSON.stringify({abNative:result.ab.includes('[native code]'),baNative:result.ba.includes('[native code]')}));
   assert.match(result.ab,/\[native code\]/);assert.match(result.ba,/\[native code\]/);
  }finally{await ctx.close()}
 });
 await check('Persistent GM marks prevent duplicate patch in unchanged document',async()=>{
  const ctx=await browser.newContext({locale:'en-US',timezoneId:'America/New_York'});
  try {
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   await p.evaluate(()=>{globalThis.before={date:Date,worker:Worker,toString:Function.prototype.toString}});
   await p.evaluate(installSource());
   assert.equal(await p.evaluate(()=>Date===before.date && Worker===before.worker && Function.prototype.toString===before.toString),true);
  }finally{await ctx.close()}
 });
 await check('Reinjection after SPA navigation preserves page and Worker behavior',async()=>{
  const ctx=await browser.newContext({locale:'en-US',timezoneId:'America/New_York'});
  try {
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   await p.evaluate(()=>history.pushState({},'', '/spa'));
   await p.evaluate(installSource());
   const result=await p.evaluate(()=>({hour:new Date(0).getHours(),zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    local:new Date(2026,0,15,9).toISOString(),source:Date.toString()}));
   console.log('SPA '+JSON.stringify(result));
   assert.equal(result.hour,9);assert.equal(result.local,'2026-01-15T00:00:00.000Z');assert.match(result.source,/\[native code\]/);
   assert.equal(await worker(p,'postMessage(new Date(0).getHours());'),9);
  }finally{await ctx.close()}
 });
 await check('Iframe navigation preserves masks and worker wrapping',async()=>{
  const ctx=await browser.newContext({locale:'en-US',timezoneId:'America/New_York'});
  try {
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   await p.evaluate(async()=>{const f=document.createElement('iframe');f.id='nav';
    await new Promise(r=>{f.onload=r;f.src='/nav1';document.body.append(f)});
    await new Promise(r=>{f.onload=r;f.src='/nav2'});void f.contentWindow;
   });
   const f=p.frames().find(x=>x.parentFrame());
   assert.equal(await f.evaluate(()=>new Date(0).getHours()),9);
   assert.match(await f.evaluate(()=>Function.prototype.toString.call(Date)),/\[native code\]/);
   assert.equal(await worker(f,'postMessage(new Date(0).getHours());'),9);
  }finally{await ctx.close()}
 });
 await check('toString does not execute supplied function proxies or proxy prototypes',async()=>{
  const ctx=await browser.newContext({locale:'en-US'});
  try {
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   const result=await p.evaluate(()=>{let traps=0;const handler={get(){traps++},getPrototypeOf(){traps++},getOwnPropertyDescriptor(){traps++}};
    const fn=new Proxy(function(){},handler);Function.prototype.toString.call(fn);
    const fn2=function(){};Object.setPrototypeOf(fn2,new Proxy({},handler));Function.prototype.toString.call(fn2);
    return traps;
   });assert.equal(result,0);
  }finally{await ctx.close()}
 });
 await check('Same-origin leaf through cross-origin middle frame can name sibling functions',async()=>{
  const ctx=await browser.newContext({locale:'en-US',timezoneId:'America/New_York'});
  try {
   const p=await ctx.newPage();await p.goto(origin);
   await p.evaluate(async cross=>{for(const [id,url] of [['direct','/direct'],['middle',cross]])await new Promise(r=>{
    const f=document.createElement('iframe');f.id=id;f.src=url;f.onload=r;document.body.append(f);
   })},origin.replace('127.0.0.1','localhost')+'/middle');
   const middle=p.frames().find(f=>f.url().endsWith('/middle'));
   await middle.evaluate(url=>new Promise(r=>{const f=document.createElement('iframe');f.src=url;f.onload=r;document.body.append(f)}),origin+'/leaf');
   const leaf=p.frames().find(f=>f.url().endsWith('/leaf')),direct=p.frames().find(f=>f.url().endsWith('/direct'));
   await leaf.evaluate(installSource());await direct.evaluate(installSource());await p.evaluate(installSource());
   const result=await leaf.evaluate(()=>{
    const other=top.frames[0];
    return {out:Function.prototype.toString.call(other.Date),back:other.Function.prototype.toString.call(Date)};
   });
   console.log('CROSS_TREE '+JSON.stringify({outNative:result.out.includes('[native code]'),backNative:result.back.includes('[native code]')}));
   assert.match(result.out,/\[native code\]/);assert.match(result.back,/\[native code\]/);
  }finally{await ctx.close()}
 });
 await check('Late-created sibling after initial registry collection',async()=>{
  const ctx=await browser.newContext({locale:'en-US'});
  try {
   const p=await ctx.newPage();await p.goto(origin);
   const add=async id=>p.evaluate(id=>new Promise(r=>{const f=document.createElement('iframe');f.id=id;f.src='/'+id;f.onload=r;document.body.append(f)}),id);
   await add('early');const early=p.frames().find(f=>f.url().endsWith('/early'));await early.evaluate(installSource());
   await add('late');const late=p.frames().find(f=>f.url().endsWith('/late'));await late.evaluate(installSource());
   assert.match(await early.evaluate(()=>Function.prototype.toString.call(parent.frames[1].Date)),/\[native code\]/);
  }finally{await ctx.close()}
 });
 await check('Discovery skips page Function/length getters and constructor proxies',async()=>{
  const ctx=await browser.newContext({locale:'en-US'});
  try {
   const p=await ctx.newPage();await p.goto(origin);await p.evaluate(installSource());
   await p.evaluate(async()=>{for(const id of ['getter','proxy'])await new Promise(r=>{const f=document.createElement('iframe');f.id=id;f.src='/'+id;f.onload=r;document.body.append(f)})});
   const result=await p.evaluate(()=>{
    let calls=0;const a=frames[0],b=frames[1];
    Object.defineProperty(a,'Function',{configurable:true,get(){calls++;return Function}});
    Object.defineProperty(a,'length',{configurable:true,get(){calls++;return 0}});
    b.Function=new Proxy(b.Function,{getOwnPropertyDescriptor(){calls++;return undefined},getPrototypeOf(){calls++;return null},get(){calls++;return undefined}});
    const unknown=function example(){};Object.setPrototypeOf(unknown,{});
    const text=Function.prototype.toString.call(unknown);
    return {calls,text};
   });assert.equal(result.calls,0);assert.match(result.text,/example/);
  }finally{await ctx.close()}
 });
 const zones=['Asia/Tokyo','America/New_York','Europe/Berlin','Pacific/Kiritimati','Europe/Dublin',
  'Africa/Casablanca','Africa/El_Aaiun','Asia/Almaty','Asia/Gaza','Asia/Amman','Asia/Beirut',
  'America/Santiago','America/Sao_Paulo','Australia/Lord_Howe','Pacific/Apia','Europe/Moscow',
  'Europe/London','Asia/Shanghai','Africa/Windhoek','America/Argentina/Buenos_Aires'];
 for(const zone of (process.argv.includes('--no-dates') ? [] : process.argv.includes('--focused') ? ['Africa/Casablanca','America/Santiago','Asia/Tokyo'] : zones)){
  const real=await browser.newContext({timezoneId:nativeDates?zone:'America/New_York',locale:'en-US'}),spoof=await browser.newContext({timezoneId:'America/New_York',locale:'en-US'});
  try{
   const n=await real.newPage(),p=await spoof.newPage();await n.goto(origin);await p.goto(origin);await p.evaluate(installSource(zone));
   if(baseline) await n.evaluate(installSource(zone,baseline));
   const expected=await n.evaluate(dateProbe,dates),actual=await p.evaluate(dateProbe,dates);
   await check((nativeDates?'Native Date parity ':'Date unchanged from v1.0.4 ')+zone,async()=>{
    const mismatches=actual.flatMap((a,i)=>JSON.stringify(a)!==JSON.stringify(expected[i])?[{actual:a,expected:expected[i]}]:[]);
    if(mismatches.length) console.log('DATE_MISMATCH '+JSON.stringify({zone,count:mismatches.length,samples:mismatches.slice(0,1)}));
    if(zone==='Africa/Casablanca'){
     const i=dates.indexOf(Date.UTC(2026,2,15));console.log('RAMADAN '+JSON.stringify({actual:actual[i],expected:expected[i]}));
    }
    assert.equal(mismatches.length,0);
   });
   if(zone==='Asia/Tokyo'){
    await check('Permission status prototype getters and event API',async()=>{
     const r=await p.evaluate(async()=>{const s=await navigator.permissions.query({name:'geolocation'});let count=0;
      s.addEventListener('change',()=>count++);s.onchange=()=>count++;s.dispatchEvent(new Event('change'));
      return {state:Object.getOwnPropertyDescriptor(PermissionStatus.prototype,'state').get.call(s),count,keys:Reflect.ownKeys(s).map(String)}});
     assert.deepEqual(r,{state:'granted',count:2,keys:[]});
    });
    await check('Worker text parity',async()=>assert.deepEqual(await worker(p,`postMessage((${dateProbe.toString()})(${JSON.stringify(dates)}));`),expected));
   }
  }finally{await real.close();await spoof.close()}
 }
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
 if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
 console.log(`RESULT ${checks} checks, ${failures} failing groups`);process.exitCode=failures?1:0;
});
