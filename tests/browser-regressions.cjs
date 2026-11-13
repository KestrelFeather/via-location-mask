const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(process.env.VLM_SOURCE || path.join(__dirname, '../via-location-mask.user.js'), 'utf8');
const config = { enabled: true, timezoneEnabled: true, timezone: 'Asia/Tokyo',
  localeEnabled: true, language: 'ja-JP', languages: ['ja-JP', 'en-US'],
  workerEnabled: true, patchUrlWorkers: true, approximateEnabled: true };
function injection(overrides = {}) {
  return `(() => {
    const values = new Map([['via-location-mask.settings.v1', ${JSON.stringify({...config, ...overrides})}],
      ['via-location-mask.ui.v1', {onboardingSeen: true}]]);
    const GM_getValue = (k, v) => values.has(k) ? values.get(k) : v;
    const GM_setValue = (k, v) => values.set(k, v);
    ${source}
  })();\n//# sourceURL=via-location-mask-test.user.js`;
}
function probe() {
  return { hour: new Date(0).getHours(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    temporal: Temporal.Now.timeZoneId(), zoned: Temporal.Now.zonedDateTimeISO().timeZoneId,
    plain: Temporal.Now.plainDateTimeISO().hour, time: Temporal.Now.plainTimeISO().hour,
    day: Temporal.Now.plainDateISO().toString(), utc: Temporal.Now.zonedDateTimeISO('UTC').timeZoneId };
}
let browser, server, origin, count = 0, failures = 0;
async function check(name, run) {
  count++;
  try { await run(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + '\n' + e.stack); }
}
async function pageWith(overrides, run) {
  const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(injection(overrides));
    await run(page);
  } finally { await context.close(); }
}
function validate(value, expected) {
  assert.equal(value.hour, 9);
  assert.equal(value.zone, 'Asia/Tokyo');
  assert.equal(value.temporal, 'Asia/Tokyo');
  assert.equal(value.zoned, 'Asia/Tokyo');
  assert.equal(value.utc, 'UTC');
  assert.equal(value.plain, expected.plain);
  assert.equal(value.time, expected.time);
  assert.equal(value.day, expected.day);
}
(async () => {
  server = http.createServer((req, res) => {
    if (req.url==='/dependency.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(`globalThis.__moduleProbe=(${probe})();`);
      return;
    }
    if (req.url.startsWith('/worker')) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end((req.url.includes('?module')?'import "./dependency.js";\n':'') +
        (req.url.includes('shared')
          ? `let n=0; onconnect=e=>e.ports[0].postMessage({n:++n,value:globalThis.__moduleProbe||(${probe})()});`
          : `postMessage(globalThis.__moduleProbe||(${probe})());`));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body>Regression fixture</body></html>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless: true,
    ...(process.env.BROWSER_PATH ? {executablePath: process.env.BROWSER_PATH} : {})});
  console.log('Browser ' + browser.version());
  await check('Temporal: all five methods, explicit zones, errors, descriptors', () => pageWith({}, async p => {
    const result = await p.evaluate(() => {
      const now = Temporal.Now;
      const expected = now.zonedDateTimeISO('Asia/Tokyo');
      const values = ['plainDateTimeISO','plainTimeISO','plainDateISO','zonedDateTimeISO'].map(key => {
        let error;
        try { now[key](null); } catch(e) { error = e.name; }
        return {key, error, source: now[key].toString(), length: now[key].length,
          constructible: Object.hasOwn(now[key], 'prototype'),
          implicit: String(now[key]()), explicit: String(now[key]('Asia/Tokyo'))};
      });
      return { zone: now.timeZoneId(), utc: now.zonedDateTimeISO('UTC').timeZoneId,
        hour: now.plainDateTimeISO().hour, expected: expected.hour, values };
    });
    assert.equal(result.zone, 'Asia/Tokyo'); assert.equal(result.utc, 'UTC');
    assert.equal(result.hour, result.expected);
    for (const row of result.values) {
      assert.equal(row.error, 'TypeError'); assert.equal(row.constructible, false);
      assert.match(row.source, /\[native code\]/); assert.equal(row.length, 0);
      // Nanosecond clocks advance between calls, compare the date/hour prefix.
      assert.equal(row.implicit.slice(0, row.key==='plainTimeISO'?5:13),
        row.explicit.slice(0, row.key==='plainTimeISO'?5:13));
    }
  }));
  for (const overrides of [{enabled:false}, {timezoneEnabled:false},
    {siteMode:'denylist', sitePatterns:['127.0.0.1']}]) {
    await check('Temporal passthrough ' + JSON.stringify(overrides), () => pageWith(overrides, async p => {
      assert.equal(await p.evaluate(() => Temporal.Now.timeZoneId()), 'America/New_York');
    }));
  }
  await check('Every synchronous insertion path and nested frame installs', () => pageWith({}, async p => {
    const results = await p.evaluate(() => {
      const methods = {
        appendChild: (host, f) => host.appendChild(f),
        insertBefore: (host, f) => host.insertBefore(f, null),
        replaceChild: (host, f) => host.replaceChild(f, host.firstChild),
        append: (host, f) => host.append(f), prepend: (host, f) => host.prepend(f),
        replaceChildren: (host, f) => host.replaceChildren(f),
        before: (host, f) => host.firstChild.before(f), after: (host, f) => host.firstChild.after(f),
        replaceWith: (host, f) => host.firstChild.replaceWith(f),
        insertAdjacentElement: (host, f) => host.insertAdjacentElement('beforeend', f),
        insertAdjacentHTML: host => host.insertAdjacentHTML('beforeend', '<iframe></iframe>'),
        innerHTML: host => { host.innerHTML = '<iframe></iframe>'; },
        outerHTML: host => { host.firstChild.outerHTML = '<iframe></iframe>'; },
        fragment: (host, f) => { const fragment = document.createDocumentFragment(); fragment.append(f); host.appendChild(fragment); },
        shadow: (host, f) => host.attachShadow({mode:'open'}).append(f),
      };
      const results = [];
      for (const [name, insert] of Object.entries(methods)) {
        const host = document.createElement('div'); host.append(document.createElement('i'));
        document.body.append(host);
        insert(host, document.createElement('iframe'));
        const child = name === 'shadow' ? host.shadowRoot.firstChild.contentWindow : frames[0];
        if (!child) throw Error('No browsing context for ' + name);
        const topHour = new child.Date(0).getHours();
        child.document.body.innerHTML = '<iframe></iframe>';
        const nested = child.frames[0];
        nested.document.body.appendChild(nested.document.createElement('iframe'));
        results.push({name, hours: [topHour, new nested.Date(0).getHours(), new nested.frames[0].Date(0).getHours()],
          zones: [child.Temporal.Now.timeZoneId(), nested.Temporal.Now.timeZoneId()],
          masked: child.Node.prototype.appendChild.toString().includes('[native code]')});
        host.remove();
      }
      return results;
    });
    for (const row of results) {
      assert.deepEqual(row.hours, [9,9,9], row.name);
      assert.deepEqual(row.zones, ['Asia/Tokyo','Asia/Tokyo'], row.name);
      assert.equal(row.masked, true, row.name);
    }
  }));
  await check('Native insertion return values and exceptions', () => pageWith({}, async p => {
    assert.deepEqual(await p.evaluate(() => {
      const a = document.createElement('div'), b = document.createElement('i'), c = document.createElement('b');
      const appended = a.appendChild(b) === b;
      const replaced = a.replaceChild(c,b) === b;
      let invalid; try { a.appendChild(a); } catch(e) { invalid=e.name; }
      return {appended,replaced,invalid};
    }), {appended:true,replaced:true,invalid:'HierarchyRequestError'});
  }));
  await check('iframe navigation and document.write retain recursive interception', () => pageWith({}, async p => {
    await p.evaluate(() => new Promise(resolve => {
      const f=document.createElement('iframe'); f.onload=resolve; f.src='/child'; document.body.append(f);
    }));
    const result = await p.evaluate(() => {
      const child=frames[0]; child.document.write('<iframe></iframe>');
      return [new child.Date(0).getHours(),new child.frames[0].Date(0).getHours()];
    });
    assert.deepEqual(result,[9,9]);
  }));
  await check('Geolocation does not call page random or crypto hooks', () => pageWith({}, async p => {
    const result = await p.evaluate(async () => {
      let calls=0; Math.random=()=>{calls++;return .1};
      crypto.getRandomValues=()=>{calls++;throw Error('page hook')};
      const one=await new Promise(resolve=>navigator.geolocation.getCurrentPosition(resolve));
      const two=await new Promise(resolve=>{const id=navigator.geolocation.watchPosition(p=>{
        navigator.geolocation.clearWatch(id);resolve(p);
      })});
      return {calls, valid:Number.isFinite(one.coords.latitude)&&Number.isFinite(two.coords.longitude)};
    });
    assert.deepEqual(result,{calls:0,valid:true});
  }));
  await check('Native geolocation errors preserve messages and page caller without script frames', () => pageWith({}, async p => {
    const errors=await p.evaluate(() => {
      function pageCaller(call) {try {call()} catch(e) {return {name:e.name,message:e.message,stack:e.stack}}}
      const calls = [()=>navigator.geolocation.getCurrentPosition(),()=>navigator.geolocation.watchPosition(),
        ()=>navigator.geolocation.clearWatch(),()=>navigator.geolocation.getCurrentPosition.call({},()=>{})];
      return calls.map(call=>pageCaller(call));
    });
    for (const error of errors) {
      assert.equal(error.name,'TypeError'); assert.ok(error.message);
      assert.match(error.stack,/pageCaller/);
      assert.doesNotMatch(error.stack,/reproduceNativeError|via-location-mask-test|stripConstruct/);
    }
    assert.equal(await p.evaluate(() => {
      const original=Error('option getter'); const stack=original.stack;
      try {navigator.geolocation.getCurrentPosition(()=>{},null,{get maximumAge(){throw original}})}
      catch(e){return e===original && e.stack===stack}
    }),true);
  }));
  await check('Anonymous injection and nested iframe error stacks', async () => {
    const context=await browser.newContext({timezoneId:'America/New_York'});
    try {
      const p=await context.newPage();await p.goto(origin);
      await p.evaluate(injection().replace(/\n\/\/# sourceURL=.*$/, ''));
      const stacks=await p.evaluate(()=>{
        const f=document.createElement('iframe');document.body.appendChild(f);
        function pageCaller(geo) {try {geo.getCurrentPosition()} catch(e) {return e.stack}}
        return [pageCaller(navigator.geolocation),pageCaller(frames[0].navigator.geolocation)];
      });
      for(const stack of stacks) {
        assert.match(stack,/pageCaller/);
        assert.doesNotMatch(stack,/reproduceNativeError|Geolocation.getCurrentPosition/);
      }
    } finally {await context.close()}
  });
  await check('Missing Temporal and SharedWorker do not break startup', async () => {
    const context=await browser.newContext({timezoneId:'America/New_York'});
    try {
      const p=await context.newPage();await p.goto(origin);
      await p.evaluate(()=>{delete globalThis.Temporal;delete globalThis.SharedWorker});
      await p.evaluate(injection());
      assert.deepEqual(await p.evaluate(()=>({hour:new Date(0).getHours(),
        temporal:typeof Temporal,shared:typeof SharedWorker})),{hour:9,temporal:'undefined',shared:'undefined'});
    } finally {await context.close()}
  });
  for (const shared of [false,true]) for (const kind of ['blob','data','url']) for (const module of [false,true]) {
    await check(`${shared?'SharedWorker':'Worker'} ${kind} ${module?'module':'classic'} Date/Temporal`, () => pageWith({}, async p => {
      const expected = await p.evaluate(probe);
      const result = await p.evaluate(async ({shared,kind,module,probe}) => {
        const code = shared ? `let n=0; onconnect=e=>e.ports[0].postMessage({n:++n,value:(${probe})()});` : `postMessage((${probe})());`;
        const url=kind==='blob'? URL.createObjectURL(new Blob([code],{type:'text/javascript'})):
          kind==='data'? 'data:text/javascript,'+encodeURIComponent(code):'/worker'+(shared?'-shared':'')+'.js'+(module?'?module':'');
        class Derived extends (shared?SharedWorker:Worker) {}
        const read=()=>new Promise((resolve,reject)=>{
          const w=new Derived(url,{type:module?'module':'classic',name:'regression'});
          const timer=setTimeout(()=>reject(Error('worker timeout')),6000);
          const port=shared?w.port:w;
          port.onmessage=e=>{clearTimeout(timer); shared?port.close():w.terminate(); resolve({data:e.data,derived:w instanceof Derived});};
          w.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'worker load failure'))};
        });
        const first=await read(),second=shared?await read():null;
        if(kind==='blob')URL.revokeObjectURL(url);
        return {first,second};
      }, {shared,kind,module,probe:probe.toString()});
      assert.equal(result.first.derived,true);
      validate(shared?result.first.data.value:result.first.data,expected);
      if(shared) { assert.equal(result.first.data.n,1); assert.equal(result.second.data.n,2); }
    }));
  }
  await check('SharedWorker legacy name overload and duplicate connections', () => pageWith({}, async p => {
    const result=await p.evaluate(async()=>{
      const url=URL.createObjectURL(new Blob(['let n=0;onconnect=e=>e.ports[0].postMessage(++n)']));
      const workers=[new SharedWorker(url,'legacy'),new SharedWorker(url,'legacy')];
      const counts=await Promise.all(workers.map(w=>new Promise(resolve=>{w.port.onmessage=e=>resolve(e.data)})));
      workers.forEach(w=>w.port.close());URL.revokeObjectURL(url);return counts;
    });assert.deepEqual(result,[1,2]);
  }));
})().catch(e=>{failures++;console.error(e)}).finally(async()=>{
  if(browser)await browser.close(); if(server)await new Promise(resolve=>server.close(resolve));
  console.log(`RESULT ${count} groups; ${failures} failed`);process.exitCode=failures?1:0;
});
