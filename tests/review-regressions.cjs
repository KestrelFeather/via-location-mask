const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const repo = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.VLM_SOURCE || path.join(repo, 'via-location-mask.user.js'), 'utf8');
const baseline = execFileSync('git', ['show','9253b5b:via-location-mask.user.js'], {cwd:repo,encoding:'utf8'});
const config = {enabled:true,timezoneEnabled:true,timezone:'Asia/Tokyo',workerEnabled:true,
  localeEnabled:true,languages:['ja-JP','en-US'],language:'ja-JP',floatingButtonEnabled:false};
function inject(script=source, overrides={}) {
  return `(()=>{
    const store=new Map([['via-location-mask.settings.v1',${JSON.stringify({...config,...overrides})}],
      ['via-location-mask.ui.v1',{onboardingSeen:true}]]);
    const GM_getValue=(k,v)=>store.has(k)?store.get(k):v;
    const GM_setValue=(k,v)=>store.set(k,v);
    ${script}
  })();\n//# sourceURL=review.user.js`;
}
let browser, server, origin, checks=0, failures=0;
async function check(name, run) {
  checks++;
  try {await run();console.log('PASS '+name)}
  catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack)}
}
async function withPage(run, {script=source,overrides={},url='/'}={}) {
  const ctx=await browser.newContext({timezoneId:'America/New_York',locale:'en-US'});
  try {
    const p=await ctx.newPage();await p.goto(origin+url);
    if(script)await p.evaluate(inject(script,overrides));
    return await run(p);
  } finally {await ctx.close()}
}
function instantProbe() {
  const instant=Temporal.Instant.fromEpochMilliseconds(0);
  const options={hour:'2-digit',hourCycle:'h23'};
  const inherited=Object.create(options);
  let reads=0;
  Object.defineProperty(inherited,'timeZone',{get(){reads++;return undefined}});
  const values={implicit:instant.toLocaleString('en-US',options),
    utc:instant.toLocaleString('en-US',{...options,timeZone:'UTC'}),
    inherited:instant.toLocaleString('en-US',inherited),reads,
    name:Temporal.Instant.prototype.toLocaleString.name,
    length:Temporal.Instant.prototype.toLocaleString.length,
    source:Temporal.Instant.prototype.toLocaleString.toString()};
  values.primitiveDefault=instant.toLocaleString('en-US',1)===instant.toLocaleString('en-US',{timeZone:'Asia/Tokyo'});
  values.frozen=instant.toLocaleString('en-US',Object.freeze({...options,timeZone:undefined}));
  values.errors=[null,1,{timeZone:'invalid zone'}].map(options=>{
    try {instant.toLocaleString('en-US',options)} catch(e){return e.name}
  });
  const error=Error('page option getter');
  try {instant.toLocaleString('en-US',{get timeZone(){throw error}})}catch(e){values.sameError=e===error}
  try {Temporal.Instant.prototype.toLocaleString.call({})}catch(e){values.brand=e.name}
  return values;
}
function verifyInstant(value) {
  assert.equal(value.implicit,'09');assert.equal(value.utc,'00');
  assert.equal(value.inherited,'09');assert.equal(value.reads,1);
  assert.equal(value.name,'toLocaleString');assert.equal(value.length,0);
  assert.match(value.source,/\[native code\]/);
  assert.deepEqual(value.errors,['TypeError',undefined,'RangeError']);
  assert.equal(value.primitiveDefault,true);
  assert.equal(value.frozen,'09');
  assert.equal(value.sameError,true);assert.equal(value.brand,'TypeError');
}
(async()=>{
  server=http.createServer((req,res)=>{
    if(req.url.startsWith('/w')) {
      res.setHeader('Content-Type','text/javascript');
      res.end(req.url.includes('shared')?'onconnect=e=>e.ports[0].postMessage("loaded")':'postMessage("loaded")');
    } else {
      if(req.url==='/trusted')res.setHeader('Content-Security-Policy',"require-trusted-types-for 'script'; trusted-types review");
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>Fixture</body>');
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  console.log('Browser '+browser.version());
  for(const experimental of [false,true])for(const shared of [false,true]) {
    await check(`TrustedScriptURL ${shared?'SharedWorker':'Worker'} patchUrlWorkers=${experimental}`,()=>withPage(async p=>{
      const value=await p.evaluate(async shared=>{
        const policy=trustedTypes.createPolicy('review',{createScriptURL:s=>s});
        class Derived extends (shared?SharedWorker:Worker) {}
        const url=policy.createScriptURL(shared?'/w-shared.js':'/w.js');
        const worker=new Derived(url);
        const port=shared?worker.port:worker;
        const message=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('worker timeout')),4000);
          port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
          worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker failed'))};
        });
        shared?port.close():worker.terminate();
        let rejected=false;
        try {new Derived(shared?'/w-shared.js':'/w.js')} catch(e){rejected=e instanceof TypeError}
        return {message,derived:worker instanceof Derived,rejected};
      },shared);
      assert.deepEqual(value,{message:'loaded',derived:true,rejected:true});
    },{url:'/trusted',overrides:{patchUrlWorkers:experimental}}));
  }
  await check('TrustedScriptURL Blob fallback and repeat SharedWorker connection',()=>withPage(async p=>{
    const result=await p.evaluate(async()=>{
      const policy=trustedTypes.createPolicy('review',{createScriptURL:s=>s});
      const url=URL.createObjectURL(new Blob(['let n=0;onconnect=e=>e.ports[0].postMessage(++n)']));
      const workers=[new SharedWorker(policy.createScriptURL(url),'same'),new SharedWorker(policy.createScriptURL(url),'same')];
      const values=await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('timeout')),4000);
        w.port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
      })));
      workers.forEach(w=>w.port.close());URL.revokeObjectURL(url);return values;
    });assert.deepEqual(result,[1,2]);
  },{url:'/trusted',overrides:{patchUrlWorkers:true}}));
  await check('Worker option TypeError is not retried',()=>withPage(async p=>{
    const result=await p.evaluate(()=>{
      let reads=0;const error=TypeError('page option TrustedScriptURL');
      try {new Worker('/w.js',{get name(){reads++;throw error}})}catch(e){return {reads,same:e===error}}
    });assert.deepEqual(result,{reads:1,same:true});
  },{overrides:{patchUrlWorkers:true}}));
  await check('Temporal.Instant in main and nested iframe',()=>withPage(async p=>{
    verifyInstant(await p.evaluate(instantProbe));
    await p.evaluate(()=>{const f=document.createElement('iframe');document.body.appendChild(f);frames[0].document.body.innerHTML='<iframe></iframe>'});
    const leaf=p.frames().find(f=>f.parentFrame()&&f.parentFrame().parentFrame());
    verifyInstant(await leaf.evaluate(instantProbe));
  }));
  for(const shared of [false,true])await check(`Temporal.Instant in ${shared?'SharedWorker':'Worker'}`,()=>withPage(async p=>{
    const value=await p.evaluate(async({shared,probe})=>{
      const code=shared?`onconnect=e=>e.ports[0].postMessage((${probe})())`:`postMessage((${probe})())`;
      const url=URL.createObjectURL(new Blob([code]));
      const w=shared?new SharedWorker(url):new Worker(url),port=shared?w.port:w;
      const value=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('worker timeout')),4000);
        port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
        w.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker failed'))};
      });
      shared?port.close():w.terminate();URL.revokeObjectURL(url);return value;
    },{shared,probe:instantProbe.toString()});verifyInstant(value);
  }));
  for(const overrides of [{enabled:false},{timezoneEnabled:false},{siteMode:'denylist',sitePatterns:['127.0.0.1']}]) {
    await check('Temporal.Instant disabled '+JSON.stringify(overrides),()=>withPage(async p=>{
      assert.equal((await p.evaluate(instantProbe)).implicit,'19');
    },{overrides}));
  }
  await check('Moved iframes and multi-frame DocumentFragments stay synchronous',()=>withPage(async p=>{
    const value=await p.evaluate(()=>{
      const fragment=document.createDocumentFragment();
      for(let i=0;i<3;i++)fragment.appendChild(document.createElement('iframe'));
      document.body.appendChild(fragment);
      const first=Array.from({length:3},(_,i)=>new frames[i].Date(0).getHours());
      const node=document.querySelector('iframe');node.remove();document.body.appendChild(node);
      return [...first,new frames[2].Date(0).getHours()];
    });assert.deepEqual(value,[9,9,9,9]);
  }));
  await check('HTML insertion positions and TrustedHTML remain synchronous',()=>withPage(async p=>{
    const value=await p.evaluate(()=>{
      const policy=trustedTypes.createPolicy('review',{createHTML:s=>s});
      return ['beforebegin','afterbegin','beforeend','afterend'].map(position=>{
        const host=document.createElement('div');document.body.appendChild(host);
        host.insertAdjacentHTML(position,policy.createHTML('<iframe></iframe>'));
        const hour=new frames[0].Date(0).getHours();document.querySelector('iframe').remove();host.remove();return hour;
      });
    });assert.deepEqual(value,[9,9,9,9]);
  },{url:'/trusted'}));
  // Deterministic work-count assertions complement wall-clock measurements.
  await check('Appending leaves never scans the old DOM or rereads existing frames',()=>withPage(async p=>{
    await p.evaluate(()=>{
      document.body.innerHTML='<div><i></i></div>'.repeat(11000)+'<iframe></iframe>'.repeat(10);
      globalThis.counts={oldQueries:0,frameReads:0};
      for(const ctor of [Element,Document]) {
        const original=ctor.prototype.querySelectorAll;
        ctor.prototype.querySelectorAll=function(...args){
          if(this===document||this===document.body||this===document.documentElement)counts.oldQueries++;
          return Reflect.apply(original,this,args);
        };
      }
      const descriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');
      Object.defineProperty(HTMLIFrameElement.prototype,'contentWindow',{...descriptor,get(){
        counts.frameReads++;return Reflect.apply(descriptor.get,this,[]);
      }});
    });
    await p.evaluate(inject());
    const counts=await p.evaluate(async()=>{
      counts.oldQueries=0;counts.frameReads=0;
      for(let i=0;i<2000;i++)document.body.appendChild(document.createElement('b'));
      for(let i=0;i<200;i++)document.body.append('text');
      for(let i=0;i<200;i++)document.body.insertAdjacentHTML('beforeend','<em>new</em>');
      await Promise.resolve();return counts;
    });assert.deepEqual(counts,{oldQueries:0,frameReads:0});
  },{script:null}));
  if(!process.env.VLM_SKIP_BENCH) {
    const rows=[];
    for(const iframeCount of [0,10,40])for(const [version,script] of [['native',null],['v1.0.5',baseline],['current',source]]) {
      const timings=[];
      for(let sample=0;sample<3;sample++)timings.push(await withPage(async p=>{
        await p.evaluate(n=>{document.body.innerHTML='<div><i></i></div>'.repeat(11000)+'<iframe></iframe>'.repeat(n)},iframeCount);
        if(script)await p.evaluate(inject(script));
        return p.evaluate(()=>{
          const time=fn=>{const start=performance.now();fn();return performance.now()-start};
          return {appendChild:time(()=>{for(let i=0;i<2000;i++)document.body.appendChild(document.createElement('b'))}),
            html:time(()=>{for(let i=0;i<200;i++)document.body.insertAdjacentHTML('beforeend','<em>new</em>')}),
            text:time(()=>{for(let i=0;i<200;i++)document.body.append('text')})};
        });
      },{script:null}));
      const median=key=>timings.map(t=>t[key]).sort((a,b)=>a-b)[1];
      rows.push({iframeCount,version,appendChildMs:median('appendChild'),htmlMs:median('html'),textMs:median('text')});
    }
    console.log('BENCHMARK '+JSON.stringify(rows));
  }
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
  console.log(`RESULT ${checks} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
