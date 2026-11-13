const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const source=fs.readFileSync(process.env.VLM_SOURCE||path.join(__dirname,'../via-location-mask.user.js'),'utf8');
// Test-only access to pure parsing helpers, never present in the distributed file.
const fixtureSource=source.replace('  if (!realmPrePatched) {',
  '  globalThis.__parseFixture = { validateSettings, parseCoordinateText };\n  if (!realmPrePatched) {');
const injection=`(()=>{const values=new Map([
  ['via-location-mask.settings.v1',{enabled:true,timezoneEnabled:true,timezone:'Asia/Tokyo',
    localeEnabled:true,language:'ja-JP',languages:['ja-JP','en-US'],workerEnabled:true,patchUrlWorkers:true,
    siteMode:'allowlist',sitePatterns:['127.0.0.1/*']}],
  ['via-location-mask.ui.v1',{onboardingSeen:true}]]);
  const GM_getValue=(k,v)=>values.has(k)?values.get(k):v;
  const GM_setValue=(k,v)=>values.set(k,v);
  ${fixtureSource}
})();\n//# sourceURL=intrinsic-test.user.js`;

async function probe({dom=false,poison=false,workerURL=null}={}) {
  const apply=Reflect.apply,define=Object.defineProperty,descriptor=Object.getOwnPropertyDescriptor;
  const mask=Function.prototype.toString;
  const counts={},saved=[],leaked=[];
  function hook(target,key,label) {
    const desc=descriptor(target,key);if(!desc||typeof desc.value!=='function')return;
    saved[saved.length]=[target,key,desc];counts[label]=0;
    define(target,key,{...desc,value:function(...args){
      counts[label]++;
      if(label==='Reflect.apply'&&typeof args[0]==='function')leaked[leaked.length]=args[0];
      if(poison)throw Error('page hook '+label);
      return apply(desc.value,this,args);
    }});
  }
  const groups=[
    [Reflect,'Reflect',['apply','construct','get','getOwnPropertyDescriptor','getPrototypeOf','ownKeys']],
    [Object,'Object',['assign','create','defineProperty','freeze','getOwnPropertyDescriptor','getPrototypeOf','keys','setPrototypeOf']],
    [WeakMap.prototype,'WeakMap',['get','set','has','delete']],
    [WeakSet.prototype,'WeakSet',['add','has','delete']],
    [Map.prototype,'Map',['get','set','has','delete','forEach']],
    [Set.prototype,'Set',['add','has','delete','forEach']],
    [Array.prototype,'Array',['slice','map','filter','some','every','find','push','sort','join','concat','includes','indexOf']],
    [Function.prototype,'Function',['bind']],
    [String.prototype,'String',['trim','split','slice','indexOf','includes','startsWith','padStart']],
    [RegExp.prototype,'RegExp',['exec','test']],
  ];
  for(let i=0;i<groups.length;i++)for(let j=0;j<groups[i][2].length;j++)hook(groups[i][0],groups[i][2][j],groups[i][1]+'.'+groups[i][2][j]);
  hook(Array.prototype,Symbol.iterator,'Array.iterator');
  hook(Set.prototype,Symbol.iterator,'Set.iterator');
  hook(Map.prototype,Symbol.iterator,'Map.iterator');
  if(dom){
    hook(NodeList.prototype,Symbol.iterator,'NodeList.iterator');
    const desc=descriptor(NodeList.prototype,'length');
    saved[saved.length]=[NodeList.prototype,'length',desc];counts['NodeList.length']=0;
    define(NodeList.prototype,'length',{...desc,get(){counts['NodeList.length']++;
      if(poison)throw Error('page hook NodeList.length');return apply(desc.get,this,[]);
    }});
  }
  let value,error;
  try {
    const names=[Date,Date.prototype.getHours,Temporal.Now.timeZoneId,Temporal.Instant.prototype.toLocaleString];
    if(dom)names[names.length]=navigator.geolocation.getCurrentPosition;
    const masks=[];
    for(let i=0;i<names.length;i++)masks[i]=apply(mask,names[i],[]);
    const hour=new Date(0).getHours(),text=new Date(0).toString();
    const date=new Date(2024,2,10,2,30);date.setHours(3);
    const temporal=Temporal.Instant.fromEpochMilliseconds(0).toLocaleString('en-US',{hour:'2-digit',hourCycle:'h23'});
    value={masks,hour,text,temporal,localHour:date.getHours()};
    if(dom){
      const host=document.createElement('div');document.body.appendChild(host);
      host.innerHTML='<iframe></iframe>';
      const frame=frames[0];value.frameHour=new frame.Date(0).getHours();
      value.frameMask=apply(mask,frame.Date,[]);
      frame.document.body.insertAdjacentHTML('beforeend','<iframe></iframe>');
      value.nestedHour=new frame.frames[0].Date(0).getHours();
      value.latitude=await new Promise(resolve=>navigator.geolocation.getCurrentPosition(p=>resolve(p.coords.latitude)));
      await new Promise(resolve=>{const id=navigator.geolocation.watchPosition(()=>{navigator.geolocation.clearWatch(id);resolve()})});
      if(workerURL)value.workerHour=await new Promise((resolve,reject)=>{
        const w=new Worker(workerURL),timer=setTimeout(()=>reject(Error('worker timeout')),4000);
        w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data)};
        w.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker error'))};
      });
      host.remove();
    }
  } catch(e) {error=String(e.stack||e)}
  finally {for(let i=saved.length-1;i>=0;i--)define(saved[i][0],saved[i][1],saved[i][2])}
  const sources=[];for(let i=0;i<leaked.length;i++)sources[i]=apply(mask,leaked[i],[]).slice(0,100);
  return {value,error,counts,leaked:sources};
}
let browser,server,origin,total=0,failures=0;
async function check(name,run){total++;const ctx=await browser.newContext({timezoneId:'America/New_York'});
  try{const page=await ctx.newPage();await page.goto(origin);await page.evaluate(injection);await run(page);console.log('PASS '+name)}
  catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack)}finally{await ctx.close()}}
function verify(result,dom){
  assert.equal(result.error,undefined);assert.deepEqual(result.leaked,[]);
  const observed=Object.entries(result.counts).filter(([,count])=>count);assert.deepEqual(observed,[]);
  assert.equal(result.value.hour,9);assert.equal(result.value.temporal,'09');assert.equal(result.value.localHour,3);
  for(const mask of result.value.masks)assert.match(mask,/\[native code\]/);
  if(dom){assert.equal(result.value.frameHour,9);assert.equal(result.value.nestedHour,9);assert.match(result.value.frameMask,/\[native code\]/);assert.ok(Number.isFinite(result.value.latitude));assert.equal(result.value.workerHour,9)}
}
(async()=>{
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body></body>')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  console.log('Browser '+browser.version());
  await check('Settings normalization and DMS coordinate parsing',async page=>{
    const result=await page.evaluate(()=>{
      const f=__parseFixture;
      return {settings:f.validateSettings({language:'ja-JP',languages:['ja-JP','en-US'],sitePatterns:['example.com','example.com']}),
        coordinates:f.parseCoordinateText('25° 2\' 0" N 121° 33\' 0" E')};
    });
    assert.deepEqual(result.settings.languages,['ja-JP','en-US']);assert.deepEqual(result.settings.sitePatterns,['example.com']);
    assert.ok(Math.abs(result.coordinates.latitude-25.0333333333333)<1e-10);
    assert.ok(Math.abs(result.coordinates.longitude-121.55)<1e-10);
  });
  await check('WeakMap.get replacement cannot reveal window wrappers',async page=>{
    const values=await page.evaluate(()=>{const get=WeakMap.prototype.get;WeakMap.prototype.get=()=>undefined;
      try{return [Function.prototype.toString.call(Date),Function.prototype.toString.call(navigator.geolocation.getCurrentPosition)]}
      finally{WeakMap.prototype.get=get}});
    for(const value of values)assert.match(value,/\[native code\]/);
  });
  for(const poison of [false,true])await check('Window intrinsic hooks '+(poison?'throw':'observe'),async page=>{
    const url=await page.evaluate(()=>URL.createObjectURL(new Blob(['postMessage(new Date(0).getHours())'])));
    verify(await page.evaluate(probe,{dom:true,poison,workerURL:url}),true);
  });
  for(const shared of [false,true])for(const poison of [false,true])await check(`${shared?'SharedWorker':'Worker'} intrinsic hooks ${poison?'throw':'observe'}`,async page=>{
    const result=await page.evaluate(async({probe,shared,poison})=>{
      const run=`(${probe})({poison:${poison}})`;
      const code=shared?`onconnect=e=>{const p=e.ports[0];${run}.then(x=>p.postMessage(x))}`:`${run}.then(x=>postMessage(x))`;
      const url=URL.createObjectURL(new Blob([code])),w=shared?new SharedWorker(url):new Worker(url),port=shared?w.port:w;
      const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),5000);
        port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};w.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker error'))}});
      shared?port.close():w.terminate();URL.revokeObjectURL(url);return result;
    },{probe:probe.toString(),shared,poison});verify(result,false);
  });
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
  console.log(`RESULT ${total} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
