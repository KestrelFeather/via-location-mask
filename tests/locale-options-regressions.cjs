const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const source = fs.readFileSync(process.env.VLM_SOURCE || path.join(__dirname, '../via-location-mask.user.js'), 'utf8');
const injection = `(()=>{
  const settings={enabled:true,timezoneEnabled:true,timezone:'Asia/Tokyo',localeEnabled:true,
    language:'ja-JP',languages:['ja-JP','en-US'],workerEnabled:true,patchUrlWorkers:true};
  const GM_getValue=(key,fallback)=>key==='via-location-mask.settings.v1'?settings:
    key==='via-location-mask.ui.v1'?{onboardingSeen:true}:fallback;
  const GM_setValue=()=>{};
  ${source}
})();`;

// Run unchanged in a pristine Tokyo realm and each spoofed New York realm.
function optionProbe() {
  const results=[];
  const apis={
    date:options=>new Date(0).toLocaleString('en-US',options),
    time:options=>new Date(0).toLocaleTimeString('en-US',options),
    day:options=>new Date(0).toLocaleDateString('en-US',options),
    intl:options=>new Intl.DateTimeFormat('en-US',options).format(0),
    intlCall:options=>Intl.DateTimeFormat('en-US',options).format(0),
    temporal:options=>Temporal.Instant.fromEpochMilliseconds(0).toLocaleString('en-US',options),
  };
  for(const [api,run] of Object.entries(apis)) {
    const cases={
      inherited:()=>Object.create({hour:'numeric',hourCycle:'h23'}),
      hidden:()=>Object.defineProperty({},'hour',{value:'numeric'}),
      frozen:()=>Object.freeze({hour:'numeric',hourCycle:'h23',timeZone:undefined}),
      inheritedUTC:()=>Object.create({hour:'numeric',hourCycle:'h23',timeZone:'UTC'}),
      explicitUTC:()=>Object.freeze({hour:'numeric',hourCycle:'h23',timeZone:'UTC'}),
      undefined:()=>undefined,
      null:()=>null,
      number:()=>1,
      string:()=>'',
      symbol:()=>Symbol('options'),
      invalidZone:()=>({timeZone:'not a timezone'}),
      ignoredGetter:()=>({hour:'numeric',get unused(){throw Error('must not read')}}),
      tracked:log=>new Proxy({hour:'numeric',hourCycle:'h23'}, {get(target,key,receiver){
        log.push(String(key));return Reflect.get(target,key,receiver);
      }}),
      getters:log=>{
        const options={};let zoneReads=0;
        // Deliberately differs from the native option-read order.
        for(const key of ['timeZone','hourCycle','hour','weekday','localeMatcher']) {
          Object.defineProperty(options,key,{get(){
            log.push([key,this===options]);
            if(key==='timeZone')return ++zoneReads===1?undefined:'UTC';
            return key==='hour'?'numeric':key==='hourCycle'?'h23':undefined;
          }});
        }
        return options;
      },
      throwingHour:(log,error)=>({get hour(){log.push('hour');throw error},get timeZone(){log.push('timeZone');return undefined}}),
      throwingZone:(log,error)=>({get hour(){log.push('hour');return 'numeric'},get timeZone(){log.push('timeZone');throw error}}),
    };
    for(const [name,make] of Object.entries(cases)) {
      const log=[],sentinel=new TypeError('page getter'),options=make(log,sentinel);
      let value,error,sameError;
      try {value=run(options)} catch(e){error=e.name;sameError=e===sentinel}
      results.push({api,name,value,error,sameError,log});
    }
  }
  for(const invalid of [false,true]) {
    const log=[],options=new Proxy({}, {get(_,key){log.push(String(key));return undefined}});
    let value,error;
    try {value=Date.prototype.toLocaleString.call(invalid?new Date(NaN):{},'en-US',options)}catch(e){error=e.name}
    results.push({invalid,value,error,log});
  }
  return results;
}

let browser,server,origin,total=0,failures=0;
async function check(name,run){total++;try{await run();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack)}}
async function withPage(timezoneId,injected,run){
  const context=await browser.newContext({timezoneId,locale:'en-US'});
  try {const page=await context.newPage();await page.goto(origin);if(injected)await page.evaluate(injection);return await run(page)}
  finally{await context.close()}
}
(async()=>{
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body></body>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  console.log('Browser '+browser.version());
  const expected=await withPage('Asia/Tokyo',false,p=>p.evaluate(optionProbe));
  assert.equal(expected.find(x=>x.api==='date'&&x.name==='inherited').value,'09');
  assert.equal(expected.find(x=>x.api==='time'&&x.name==='hidden').value,'9 AM');
  await check('Window Date/Intl/Temporal option semantics match native Tokyo',()=>withPage('America/New_York',true,async p=>{
    assert.deepEqual(await p.evaluate(optionProbe),expected);
  }));
  await check('Nested iframe option semantics match native Tokyo',()=>withPage('America/New_York',true,async p=>{
    const actual=await p.evaluate(code=>{
      const outer=document.createElement('iframe');document.body.appendChild(outer);
      const inner=outer.contentDocument.createElement('iframe');outer.contentDocument.body.appendChild(inner);
      return inner.contentWindow.eval('('+code+')()');
    },optionProbe.toString());assert.deepEqual(actual,expected);
  }));
  for(const shared of [false,true])await check(`${shared?'SharedWorker':'Worker'} option semantics match native Tokyo`,()=>withPage('America/New_York',true,async p=>{
    const actual=await p.evaluate(async({code,shared})=>{
      const body=shared?`onconnect=e=>e.ports[0].postMessage((${code})())`:`postMessage((${code})())`;
      const url=URL.createObjectURL(new Blob([body]));const worker=shared?new SharedWorker(url):new Worker(url);
      const port=shared?worker.port:worker;
      try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker timeout')),5000);
        port.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))};
      })}finally{shared?port.close():worker.terminate();URL.revokeObjectURL(url)}
    },{code:optionProbe.toString(),shared});assert.deepEqual(actual,expected);
  }));
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  console.log(`RESULT ${total} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
