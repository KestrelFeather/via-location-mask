const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const repo=path.join(__dirname,'..');
const source=fs.readFileSync(process.env.VLM_SOURCE||path.join(repo,'via-location-mask.user.js'),'utf8');
const config={enabled:true,timezoneEnabled:true,timezone:'Asia/Tokyo',localeEnabled:true,
  language:'ja-JP',languages:['ja-JP','en-US'],workerEnabled:true};
function injection(script,fixture=false){
  if(fixture)script=script.replace('  if (!realmPrePatched) {',
    '  globalThis.__cacheFixture = { update(next) { saveSettings({ ...settings, ...next }); } };\n  if (!realmPrePatched) {');
  return `(()=>{const GM_getValue=(key,fallback)=>key==='via-location-mask.settings.v1'?${JSON.stringify(config)}:
    key==='via-location-mask.ui.v1'?{onboardingSeen:true}:fallback;const GM_setValue=()=>{};${script}})()`;
}
let browser,server,origin,total=0,failures=0;
async function withPage(script,fixture,run){
  const context=await browser.newContext({timezoneId:script?'America/New_York':'Asia/Tokyo',locale:'en-US'});
  try{
    const page=await context.newPage();await page.goto(origin);
    if(fixture)await page.evaluate(()=>{
      const apply=Reflect.apply,construct=Reflect.construct,Native=Intl.DateTimeFormat;
      const stats=globalThis.__formatStats={constructs:0,nativeCalls:0};
      Intl.DateTimeFormat=new Proxy(Native,{construct(target,args,newTarget){stats.constructs++;return construct(target,args,newTarget)}});
      for(const name of ['toLocaleString','toLocaleDateString','toLocaleTimeString']){
        const native=Date.prototype[name];Date.prototype[name]=function(...args){stats.nativeCalls++;return apply(native,this,args)};
      }
    });
    if(script)await page.evaluate(injection(script,fixture));
    return await run(page);
  }finally{await context.close()}
}
async function check(name,run){total++;try{await withPage(source,true,run);console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack)}}
(async()=>{
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body></body>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  console.log('Browser '+browser.version());
  await check('Default calls reuse three formatters; explicit options and locale objects bypass cache',async page=>{
    const result=await page.evaluate(()=>{
      const stats=__formatStats,date=new Date(0),methods=['toLocaleString','toLocaleDateString','toLocaleTimeString'];
      stats.constructs=stats.nativeCalls=0;
      for(let i=0;i<2000;i++)for(const method of methods)date[method]('en-US');
      const cached={...stats};stats.constructs=stats.nativeCalls=0;
      for(const method of methods){
        date[method]('en-US',undefined);date[method]('en-US',{});
        date[method]('en-US',Object.freeze({timeZone:undefined}));date[method](['en-US']);
      }
      return {cached,bypassed:{...stats}};
    });
    assert.deepEqual(result.cached,{constructs:3,nativeCalls:0});
    assert.deepEqual(result.bypassed,{constructs:0,nativeCalls:12});
  });
  await check('Settings changes invalidate defaults and respect protection/language switches',async page=>{
    const result=await page.evaluate(()=>{
      const date=new Date(0),out=[];
      const record=()=>out.push(date.toLocaleString());
      record();record();
      __cacheFixture.update({timezone:'UTC'});record();
      __cacheFixture.update({language:'en-US',languages:['en-US']});record();
      __cacheFixture.update({timezone:'Asia/Tokyo',language:'ja-JP',languages:['ja-JP'],localeEnabled:false});record();
      __cacheFixture.update({enabled:false});record();
      __cacheFixture.update({enabled:true,localeEnabled:true});record();
      __cacheFixture.update({timezoneEnabled:false});record();
      __cacheFixture.update({timezoneEnabled:true});record();
      return out;
    });
    assert.deepEqual(result,['1970/1/1 9:00:00','1970/1/1 9:00:00','1970/1/1 0:00:00',
      '1/1/1970, 12:00:00 AM','1/1/1970, 9:00:00 AM','12/31/1969, 7:00:00 PM',
      '1970/1/1 9:00:00','1969/12/31 19:00:00','1970/1/1 9:00:00']);
  });
  await check('Locale cache is bounded and evicted locales remain correct',async page=>{
    const result=await page.evaluate(()=>{
      __formatStats.constructs=0;const date=new Date(0),values=[];
      for(let i=0;i<40;i++)values.push(date.toLocaleString('en-US-x-loc'+i));
      values.push(date.toLocaleString('en-US-x-loc0'));
      return {values,constructs:__formatStats.constructs};
    });
    assert.equal(result.constructs,41);assert.deepEqual(result.values,Array(41).fill('1/1/1970, 9:00:00 AM'));
  });
  if(process.env.VLM_BENCH==='1'){
    const baseline=execFileSync('git',['show','930d6cf:via-location-mask.user.js'],{cwd:repo,encoding:'utf8'});
    for(const [version,script] of [['native',null],['v1.0.9',baseline],['current',source]]){
      const samples=[];
      for(let repeat=0;repeat<3;repeat++)samples.push(await withPage(script,false,page=>page.evaluate(()=>{
        const result={},date=new Date(0);let checksum=0;
        for(const method of ['toLocaleString','toLocaleDateString','toLocaleTimeString']){
          for(let i=0;i<200;i++)date[method]('en-US');
          const start=performance.now();for(let i=0;i<20000;i++)checksum+=date[method]('en-US').length;
          result[method]=performance.now()-start;
        }
        return {...result,checksum};
      })));
      const median={};for(const method of ['toLocaleString','toLocaleDateString','toLocaleTimeString'])median[method]=samples.map(x=>x[method]).sort((a,b)=>a-b)[1];
      console.log('BENCH '+JSON.stringify({version,iterations:20000,medianMs:median,samples}));
    }
  }
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  console.log(`RESULT ${total} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
