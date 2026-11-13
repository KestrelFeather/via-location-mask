const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const source=fs.readFileSync(process.env.VLM_SOURCE||path.join(__dirname,'../via-location-mask.user.js'),'utf8');
function injection(named=false){return `(()=>{
  const GM_getValue=(key,fallback)=>key==='via-location-mask.settings.v1'?{
    enabled:true,timezoneEnabled:true,timezone:'Asia/Tokyo',localeEnabled:true,language:'ja-JP',languages:['ja-JP','en-US'],
    workerEnabled:true,patchUrlWorkers:true}:key==='via-location-mask.ui.v1'?{onboardingSeen:true}:fallback;
  const GM_setValue=()=>{};${source}
})()`+(named?'\n//# sourceURL=stack-mask.user.js':'')}
function stackProbe(){
  const cases={
    getHours(){Date.prototype.getHours.call({})},
    setHours(){Date.prototype.setHours.call({},1)},
    localeCached(){new Date(0).toLocaleString('!!')},
    localeOptions(){new Date(0).toLocaleString('!!',{})},
    localeDate(){new Date(0).toLocaleDateString('!!')},
    localeTime(){new Date(0).toLocaleTimeString('!!')},
    dateTimeFormat(){new Intl.DateTimeFormat('en',{timeZone:'Bad/Zone'})},
    temporal(){Temporal.Now.plainDateISO('Bad/Zone')},
    temporalInstant(){Temporal.Instant.prototype.toLocaleString.call(null)},
    intlNumber(){new Intl.NumberFormat('!!')},
    numberLocale(){Number.prototype.toLocaleString.call({})},
    stringLocale(){String.prototype.toLocaleLowerCase.call(null)},
    functionSource(){Function.prototype.toString.call({})},
    dateConstructor(){new Date(Symbol())},
    dateText(){Date.prototype.toString.call({})},
  };
  if(typeof document!=='undefined')Object.assign(cases,{
    append(){document.body.appendChild('x')},
    insertHTML(){document.body.insertAdjacentHTML('bad-position','x')},
    innerHTML(){Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML').set.call({},'x')},
    worker(){new Worker()},
    workerCall(){Worker('x')},
    sharedWorker(){new SharedWorker()},
    navigatorGetter(){Object.getOwnPropertyDescriptor(Navigator.prototype,'language').get.call({})},
    geo(){navigator.geolocation.getCurrentPosition()},
  });
  function pageCaller(fn){try{fn()}catch(e){return {name:e.name,message:e.message,stack:e.stack}}throw Error('did not throw')}
  const results={};for(const key of Object.keys(cases))results[key]=pageCaller(cases[key]);
  return results;
}
function pageErrorProbe(){
  const checks=[];
  for(const run of [
    get=>new Date(0).toLocaleString('en-US',{get timeZone(){return get()}}),
    get=>new Intl.DateTimeFormat('en-US',{get timeZone(){return get()}}),
    get=>new Date(0).toLocaleString({get length(){return get()}}),
    get=>Temporal.Instant.fromEpochMilliseconds(0).toLocaleString('en-US',{get timeZone(){return get()}}),
    get=>new Date({valueOf:get}),
  ]){
    for(const fresh of [false,true]){
      let error=new TypeError('page sentinel'),before=error.stack;
      function nativeApply(){if(fresh){try{JSON.parse('!')}catch(e){error=e;before=e.stack}}throw error}
      try{run(nativeApply)}catch(e){checks.push(e===error&&e.stack===before)}
    }
    for(const thrown of [undefined,null,'sentinel',Symbol('sentinel')]){
      try{run(()=>{throw thrown})}catch(e){checks.push(e===thrown)}
    }
    let traps=0;const thrown=new Proxy({}, {get(){traps++;throw 1},getOwnPropertyDescriptor(){traps++;throw 2}});
    try{run(()=>{throw thrown})}catch(e){checks.push(e===thrown&&traps===0)}
    const error=new Error('stack getter');let reads=0;
    Object.defineProperty(error,'stack',{get(){reads++;return 'page stack'},configurable:true});
    const before=Object.getOwnPropertyDescriptor(error,'stack');
    try{run(()=>{throw error})}catch(e){checks.push(e===error&&reads===0&&Object.getOwnPropertyDescriptor(e,'stack').get===before.get)}
  }
  return checks;
}
const probeCode=`globalThis.runStackProbe=(${stackProbe});globalThis.runPageErrorProbe=(${pageErrorProbe});\n//# sourceURL=page-stack-cases.js`;
let browser,server,origin,total=0,failures=0;
async function withPage(mask,run,named=false){
  const ctx=await browser.newContext({timezoneId:'America/New_York'});
  try{const page=await ctx.newPage();await page.goto(origin);if(mask)await page.evaluate(injection(named));return await run(page)}finally{await ctx.close()}
}
async function check(name,run){total++;try{await run();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack)}}
async function windowProbe(page,child=false,limit=10,deep=false){return page.evaluate(({code,child,limit,deep})=>{
  let realm=window;if(child){const frame=document.createElement('iframe');document.body.appendChild(frame);realm=frame.contentWindow}
  realm.Error.stackTraceLimit=limit;realm.eval(code);
  return realm.eval('function pageRecursion(n){return n?pageRecursion(n-1):{stacks:runStackProbe(),pageErrors:runPageErrorProbe()}};pageRecursion('+ (deep?30:0) +')\n//# sourceURL=page-stack-entry.js');
},{code:probeCode,child,limit,deep})}
async function workerProbe(page,shared){return page.evaluate(async({code,shared})=>{
  const body=`${code}\n${shared?'onconnect=e=>{const port=e.ports[0];port.onmessage=function pageWorkerCaller(){port.postMessage({stacks:runStackProbe(),pageErrors:runPageErrorProbe()})}}':
    'onmessage=function pageWorkerCaller(){postMessage({stacks:runStackProbe(),pageErrors:runPageErrorProbe()})}'}\n//# sourceURL=page-worker-stack.js`;
  const url=URL.createObjectURL(new Blob([`eval(${JSON.stringify(body)})`])),worker=shared?new SharedWorker(url):new Worker(url),port=shared?worker.port:worker;
  try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker timeout')),5000);
    port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))};
    port.postMessage('probe');
  })}finally{shared?port.close():worker.terminate();URL.revokeObjectURL(url)}
},{code:probeCode,shared})}
function verify(actual,expected){
  for(const key of Object.keys(expected.stacks))assert.deepEqual(actual.stacks[key],expected.stacks[key],key);
  assert.equal(actual.pageErrors.length,40);assert.ok(actual.pageErrors.every(Boolean),JSON.stringify(actual.pageErrors));
}
(async()=>{
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body></body>')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  console.log('Browser '+browser.version());
  for(const child of [false,true])for(const named of [false,true])await check(`${child?'iframe':'window'} ${named?'named':'anonymous'} stacks match native frame for frame`,async()=>{
    const expected=await withPage(false,p=>windowProbe(p,child));
    const actual=await withPage(true,p=>windowProbe(p,child),named);verify(actual,expected);
  });
  for(const child of [false,true])for(const limit of [0,1,2,20])await check(`${child?'iframe':'window'} deep stackTraceLimit=${limit}`,async()=>{
    verify(await withPage(true,p=>windowProbe(p,child,limit,true)),await withPage(false,p=>windowProbe(p,child,limit,true)));
  });
  for(const child of [false,true])await check(`${child?'iframe':'window'} custom prepareStackTrace is not eagerly called or replaced`,()=>withPage(true,async page=>{
    const result=await page.evaluate(child=>{
      let realm=window;if(child){const frame=document.createElement('iframe');document.body.appendChild(frame);realm=frame.contentWindow}
      return realm.eval(`(()=>{
        let calls=0;const prepare=(error)=>{calls++;return 'page custom '+error.name};Error.prepareStackTrace=prepare;
        let error;try{Date.prototype.getHours.call({})}catch(e){error=e}
        const before=calls,value=error.stack;
        return {before,value,calls,same:Error.prepareStackTrace===prepare};
      })()`);
    },child);assert.deepEqual(result,{before:0,value:'page custom TypeError',calls:1,same:true});
  }));
  for(const shared of [false,true])await check(`${shared?'SharedWorker':'Worker'} stacks and page errors`,async()=>{
    verify(await withPage(true,p=>workerProbe(p,shared)),await withPage(false,p=>workerProbe(p,shared)));
  });
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
  console.log(`RESULT ${total} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
