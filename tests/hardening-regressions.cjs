const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const source = fs.readFileSync(process.env.VLM_SOURCE || path.join(__dirname,'../via-location-mask.user.js'),'utf8');
const injection = `(()=>{
  const values=new Map([['via-location-mask.settings.v1',{enabled:true,timezoneEnabled:true,
    timezone:'Asia/Tokyo',workerEnabled:true,patchUrlWorkers:true}],
    ['via-location-mask.ui.v1',{onboardingSeen:true}]]);
  const GM_getValue=(k,v)=>values.has(k)?values.get(k):v;
  const GM_setValue=(k,v)=>values.set(k,v);
  ${source}
})();\n//# sourceURL=hardening.user.js`;
let browser,server,origin,checks=0,failures=0;
async function check(name,run,trusted=false) {
  checks++;
  const context=await browser.newContext({timezoneId:'America/New_York'});
  try {
    const page=await context.newPage();await page.goto(origin+(trusted?'/trusted':'/'));
    await page.evaluate(injection);await run(page);console.log('PASS '+name);
  } catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack)}
  finally {await context.close()}
}
// Install all hooks after the userscript, including on an independently patched
// child realm. Return fake records or throw to ensure hooks cannot steer coverage.
async function observerProbe(page, child, throwing) {
  return page.evaluate(async ({child,throwing})=>{
    let realm=window;
    if(child){const f=document.createElement('iframe');document.body.appendChild(f);realm=frames[0]}
    const doc=realm.document;
    const original=realm.MutationObserver;
    const counts={constructor:0,observe:0,takeRecords:0,disconnect:0,addedNodes:0};
    const hook=key=>{
      counts[key]++;
      if(throwing===key)throw Error('page '+key+' hook');
    };
    if(!throwing||throwing==='constructor')realm.MutationObserver=new Proxy(original,{
      construct(target,args,newTarget){hook('constructor');return Reflect.construct(target,args,newTarget)}
    });
    for(const key of ['observe','takeRecords','disconnect']){
      if(throwing&&throwing!==key)continue;
      const native=original.prototype[key];
      original.prototype[key]=function(...args){
        hook(key);
        if(key==='takeRecords')return []; // A forged empty list must not hide frames.
        return Reflect.apply(native,this,args);
      };
    }
    const descriptor=Object.getOwnPropertyDescriptor(realm.MutationRecord.prototype,'addedNodes');
    if(!throwing||throwing==='addedNodes')Object.defineProperty(realm.MutationRecord.prototype,'addedNodes',{...descriptor,get(){
      hook('addedNodes');return []; // Also tests the long-lived observer callback.
    }});
    const host=doc.createElement('div');doc.body.appendChild(host);
    const hours=[];
    host.innerHTML='<iframe></iframe>';hours.push(new realm.frames[0].Date(0).getHours());
    host.innerHTML='';
    host.insertAdjacentHTML('beforeend','<iframe></iframe>');hours.push(new realm.frames[0].Date(0).getHours());
    host.innerHTML='';
    const anchor=doc.createElement('i');host.appendChild(anchor);
    anchor.outerHTML='<iframe></iframe>';hours.push(new realm.frames[0].Date(0).getHours());
    host.innerHTML='';
    for(let i=0;i<5000;i++)host.innerHTML='<span>text</span>';
    // Also let the persistent observer consume its queued records. Its native
    // addedNodes getter must remain independent of the page's forged getter.
    const range=doc.createRange();range.selectNodeContents(host);
    const fragment=range.createContextualFragment('<iframe></iframe>');
    host.appendChild(fragment);
    await Promise.resolve();
    hours.push(new realm.frames[0].Date(0).getHours());
    return {counts,hours,text:host.querySelector('span').textContent};
  },{child,throwing});
}
(async()=>{
  server=http.createServer((req,res)=>{
    if(req.url.startsWith('/worker')){
      res.setHeader('Content-Type','text/javascript');
      res.end(req.url.includes('shared')?'onconnect=e=>e.ports[0].postMessage("ok")':'postMessage("ok")');
    }else{
      if(req.url==='/trusted')res.setHeader('Content-Security-Policy',"require-trusted-types-for 'script'; trusted-types review");
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>Fixture</body>');
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  console.log('Browser '+browser.version());
  for(const shared of [false,true])for(const blob of [false,true])for(const options of [{},{type:'classic'},{name:'x'},{type:'module'}]){
    await check(`TT ${shared?'SharedWorker':'Worker'} ${blob?'Blob':'URL'} ${JSON.stringify(options)}`,async page=>{
      const result=await page.evaluate(async ({shared,blob,options})=>{
        const policy=trustedTypes.createPolicy('review',{createScriptURL:s=>s});
        const raw=blob?URL.createObjectURL(new Blob([shared?
          'onconnect=e=>e.ports[0].postMessage("ok")':'postMessage("ok")'],{type:'text/javascript'})):
          shared?'/worker-shared.js':'/worker.js';
        class Derived extends (shared?SharedWorker:Worker){}
        const worker=new Derived(policy.createScriptURL(raw),options),port=shared?worker.port:worker;
        const message=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('worker timeout')),4000);
          port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
          worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker failed'))};
        });
        shared?port.close():worker.terminate();if(blob)URL.revokeObjectURL(raw);
        return {message,derived:worker instanceof Derived};
      },{shared,blob,options});
      assert.deepEqual(result,{message:'ok',derived:true});
    },true);
  }
  for(const shared of [false,true]){
    await check(`TT ${shared?'SharedWorker':'Worker'} throwing option is not retried`,async page=>{
      const result=await page.evaluate(shared=>{
        const policy=trustedTypes.createPolicy('review',{createScriptURL:s=>s});
        let reads=0;const error=TypeError("This document requires 'TrustedScriptURL' assignment.");
        try {new (shared?SharedWorker:Worker)(policy.createScriptURL('/worker.js'),{
          get name(){reads++;throw error}
        })}catch(e){return {reads,same:e===error}}
      },shared);assert.deepEqual(result,{reads:1,same:true});
    },true);
    await check(`TT ${shared?'SharedWorker':'Worker'} successful getter permits fallback`,async page=>{
      const result=await page.evaluate(async shared=>{
        const policy=trustedTypes.createPolicy('review',{createScriptURL:s=>s});
        let reads=0;
        const worker=new (shared?SharedWorker:Worker)(policy.createScriptURL(shared?'/worker-shared.js':'/worker.js'),{
          get name(){reads++;return 'twice'}
        }),port=shared?worker.port:worker;
        const message=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('worker timeout')),4000);
          port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
          worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker failed'))};
        });
        shared?port.close():worker.terminate();return {reads,message};
      },shared);assert.deepEqual(result,{reads:2,message:'ok'});
    },true);
  }
  for(const child of [false,true])for(const throwing of [null,'constructor','observe','takeRecords','disconnect','addedNodes']){
    await check(`Observer ${child?'iframe':'top'} ${throwing?'throwing '+throwing:'counting and forged records'}`,async page=>{
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      const result=await observerProbe(page,child,throwing);
      assert.deepEqual(result.counts,{constructor:0,observe:0,takeRecords:0,disconnect:0,addedNodes:0});
      assert.deepEqual(result.hours,[9,9,9,9]);assert.equal(result.text,'text');
      await page.evaluate(()=>new Promise(r=>setTimeout(r,0)));
      assert.deepEqual(errors,[]);
    });
  }
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
  console.log(`RESULT ${checks} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
