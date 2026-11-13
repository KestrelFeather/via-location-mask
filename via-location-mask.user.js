// ==UserScript==
// @name         Via Location Mask
// @namespace    https://kestrelfeather.com/via-location-mask
// @version      1.0.11
// @description  Site-scoped geolocation, locale and timezone protection for Via Browser.
// @author       Via Location Mask contributors
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      geocoding-api.open-meteo.com
// @connect      timeapi.io
// @connect      api64.ipify.org
// @connect      ident.me
// @connect      ifconfig.me
// @connect      icanhazip.com
// @connect      get.geojs.io
// @connect      free.freeipapi.com
// @connect      reallyfreegeoip.org
// @connect      ipinfo.io
// ==/UserScript==

/*
 * Via Location Mask
 * Copyright (c) 2026 Via Location Mask contributors
 * Copyright (c) 2026 Anthony Sgro
 *
 * Geolocation object-model and anti-detection techniques are adapted from
 * Anthony Sgro's GeoSpoof browser extension:
 * https://github.com/anthonysgro/geospoof
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * This userscript is an independent derivative. It is not affiliated with or
 * endorsed by GeoSpoof or Via Browser. It changes only what webpages read; it
 * does not change Android system GPS or the network IP address.
 */

(function () {
  "use strict";

  // Private, startup-only snapshot. Never pass this object to page callbacks.
  // The same factory is serialized into workers before their scripts execute.
  function captureIntrinsics(root) {
    "use strict"; // The serialized worker factory must retain strict receiver semantics.
    const apply = root.Reflect.apply;
    const ownNames = root.Object.getOwnPropertyNames;
    const descriptor = root.Object.getOwnPropertyDescriptor;
    const create = root.Object.create;
    const isArray = root.Array.isArray;
    const I = create(null);
    const uncurried = (fn) => (receiver, ...args) => apply(fn, receiver, args);
    const snapshot = (object) => {
      const copy = create(null);
      const names = ownNames(object);
      for (let index = 0; index < names.length; index++) {
        const entry = descriptor(object, names[index]);
        if (entry && "value" in entry) copy[names[index]] = entry.value;
      }
      return copy;
    };
    I.Reflect = snapshot(root.Reflect);
    I.Object = snapshot(root.Object);
    I.Array = snapshot(root.Array);
    I.Number = snapshot(root.Number);
    I.Math = snapshot(root.Math);
    I.JSON = snapshot(root.JSON);
    I.Proxy = root.Proxy;
    const PromiseCtor = root.Promise, promiseResolve = PromiseCtor.resolve;
    I.Promise = PromiseCtor;
    I.promiseResolve = (value) => apply(promiseResolve, PromiseCtor, [value]);
    const setTimer = root.setTimeout, clearTimer = root.clearTimeout;
    const microtask = root.queueMicrotask;
    I.setTimeout = (...args) => apply(setTimer, root, args);
    I.clearTimeout = (...args) => apply(clearTimer, root, args);
    I.queueMicrotask = (...args) => apply(microtask, root, args);
    I.ObjectCtor = root.Object;
    I.NumberCtor = root.Number;
    I.BooleanCtor = root.Boolean;
    I.StringCtor = root.String;
    I.RegExp = root.RegExp;
    // Share native option reads across Date, Intl and Temporal (also in workers).
    // Do not read timeZone eagerly: getters must run in the native order with
    // their original receiver. An empty target permits frozen undefined values.
    I.withTimezone = (options, timezone) => {
      if (options === null) return options; // Preserve native invalid-option errors.
      const original = options === undefined ? create(null) : I.ObjectCtor(options);
      return new I.Proxy(create(null), { get(_, key) {
        const value = I.Reflect.get(original, key, original);
        return key === "timeZone" && value === undefined ? timezone : value;
      } });
    };
    I.bind = uncurried(root.Function.prototype.bind);
    I.hasOwn = uncurried(root.Object.prototype.hasOwnProperty);
    I.lookupGetter = uncurried(root.Object.prototype.__lookupGetter__);
    const WeakMapCtor = root.WeakMap, WeakSetCtor = root.WeakSet;
    const MapCtor = root.Map, SetCtor = root.Set;
    const collectionTypes = ["WeakMap", "WeakSet", "Map", "Set"];
    const collectionMethods = ["get", "set", "has", "add", "delete", "clear", "forEach"];
    for (let t = 0; t < collectionTypes.length; t++) {
      const type = collectionTypes[t], proto = root[type].prototype;
      for (let m = 0; m < collectionMethods.length; m++) {
        const method = collectionMethods[m];
        if (typeof proto[method] === "function") I[type + method] = uncurried(proto[method]);
      }
    }
    const nodeListLength = root.NodeList && descriptor(root.NodeList.prototype, "length").get;
    const htmlCollectionLength = root.HTMLCollection && descriptor(root.HTMLCollection.prototype, "length").get;
    I.list = (value) => {
      const result = [];
      if (isArray(value) || typeof value === "string") {
        for (let index = 0; index < value.length; index++) result[index] = value[index];
        return result;
      }
      if (value instanceof SetCtor) {
        I.SetforEach(value, (item) => { result[result.length] = item; });
        return result;
      }
      if (value instanceof MapCtor) {
        I.MapforEach(value, (item, key) => { result[result.length] = [key, item]; });
        return result;
      }
      let length;
      if (nodeListLength) {
        try { length = apply(nodeListLength, value, []); } catch (_) {}
      }
      if (length === undefined && htmlCollectionLength) {
        try { length = apply(htmlCollectionLength, value, []); } catch (_) {}
      }
      if (length === undefined) length = value.length; // arguments / private array-like
      for (let index = 0; index < length; index++) result[index] = value[index];
      return result;
    };
    I.newWeakMap = () => new WeakMapCtor();
    I.newMap = () => new MapCtor();
    I.newWeakSet = (values) => {
      const result = new WeakSetCtor();
      if (values) for (let index = 0; index < values.length; index++) I.WeakSetadd(result, values[index]);
      return result;
    };
    I.newSet = (values) => {
      const result = new SetCtor();
      if (values) for (let index = 0; index < values.length; index++) I.Setadd(result, values[index]);
      return result;
    };
    I.Array.from = I.list;
    I.Object.fromEntries = (entries) => {
      const result = {};
      for (let index = 0; index < entries.length; index++) {
        I.Object.defineProperty(result, entries[index][0], {
          value: entries[index][1], writable: true, enumerable: true, configurable: true,
        });
      }
      return result;
    };
    const arrayMethods = ["slice", "map", "filter", "some", "every", "find", "findIndex", "forEach",
      "push", "sort", "splice", "join", "concat", "includes", "indexOf"];
    const stringMethods = ["slice", "includes", "indexOf", "concat", "charCodeAt", "endsWith", "startsWith",
      "toLowerCase", "toUpperCase", "trim", "padStart", "split", "replace", "match", "matchAll"];
    I.methods = create(null);
    for (let index = 0; index < arrayMethods.length; index++) {
      const name = arrayMethods[index], native = root.Array.prototype[name];
      I.methods[name] = uncurried(native);
    }
    for (let index = 0; index < stringMethods.length; index++) {
      const name = stringMethods[index], native = root.String.prototype[name];
      const arrayMethod = root.Array.prototype[name];
      I.methods[name] = (receiver, ...args) => apply(
        typeof receiver === "string" || typeof arrayMethod !== "function" ? native : arrayMethod,
        receiver, args);
    }
    I.methods.exec = uncurried(root.RegExp.prototype.exec);
    I.methods.test = (receiver, value) => I.methods.exec(receiver, value) !== null;
    // String's native match/replace/split still call RegExp.exec and @@species.
    // Isolate our internal expressions so those implicit calls cannot escape
    // through page replacements even though the outer String method was saved.
    const NativeRegExp = root.RegExp, define = root.Object.defineProperty;
    const regexSource = descriptor(NativeRegExp.prototype, "source").get;
    const flagNames = ["hasIndices", "global", "ignoreCase", "multiline", "dotAll", "unicode", "unicodeSets", "sticky"];
    const flagLetters = ["d", "g", "i", "m", "s", "u", "v", "y"];
    const flagGetters = [];
    for (let index = 0; index < flagNames.length; index++) {
      const entry = descriptor(NativeRegExp.prototype, flagNames[index]);
      flagGetters[index] = entry && entry.get;
    }
    const symbols = [root.Symbol.match, root.Symbol.matchAll, root.Symbol.replace, root.Symbol.search, root.Symbol.split];
    const symbolMethods = [];
    for (let index = 0; index < symbols.length; index++) symbolMethods[index] = NativeRegExp.prototype[symbols[index]];
    const regexExec = NativeRegExp.prototype.exec;
    function privateRegExp(pattern, flags) {
      const value = new NativeRegExp(pattern, flags);
      define(value, "exec", { value: regexExec });
      define(value, "constructor", { value: privateRegExp });
      let nativeFlags = "";
      for (let index = 0; index < flagNames.length; index++) {
        if (!flagGetters[index]) continue;
        const enabled = apply(flagGetters[index], value, []);
        define(value, flagNames[index], { value: enabled });
        if (enabled) nativeFlags += flagLetters[index];
      }
      define(value, "flags", { value: nativeFlags });
      for (let index = 0; index < symbols.length; index++) define(value, symbols[index], { value: symbolMethods[index] });
      return value;
    }
    define(privateRegExp, root.Symbol.species, { value: privateRegExp });
    const isolateRegex = (value) => {
      let source;
      try { source = apply(regexSource, value, []); } catch (_) { return value; }
      let flags = "";
      for (let index = 0; index < flagNames.length; index++) {
        if (flagGetters[index] && apply(flagGetters[index], value, [])) flags += flagLetters[index];
      }
      const result = privateRegExp(source, flags);
      result.lastIndex = value.lastIndex;
      return result;
    };
    const regexStringNames = ["match", "replace", "split"];
    for (let index = 0; index < regexStringNames.length; index++) {
      const name = regexStringNames[index], native = root.String.prototype[name];
      I.methods[name] = (receiver, ...args) => {
        args[0] = isolateRegex(args[0]);
        return apply(native, receiver, args);
      };
    }
    const matchAll = root.String.prototype.matchAll;
    const matchNext = root.Object.getPrototypeOf(apply(matchAll, "", [/(?:)/g])).next;
    I.methods.matchAll = (receiver, expression) => {
      const iterator = apply(matchAll, receiver, [isolateRegex(expression)]), result = [];
      for (;;) {
        const step = apply(matchNext, iterator, []);
        if (step.done) return result;
        result[result.length] = step.value;
      }
    };
    I.methods.toFixed = uncurried(root.Number.prototype.toFixed);
    const dateNames = ["getTime", "getUTCDate", "getUTCDay", "getUTCFullYear", "getUTCHours",
      "getUTCMilliseconds", "getUTCMinutes", "getUTCMonth", "getUTCSeconds", "setUTCFullYear", "setUTCHours"];
    for (let index = 0; index < dateNames.length; index++) I.methods[dateNames[index]] = uncurried(root.Date.prototype[dateNames[index]]);
    I.dateNow = root.Date.now;
    I.dateUTC = root.Date.UTC;
    I.dateParse = root.Date.parse;
    I.formatToParts = uncurried(root.Intl.DateTimeFormat.prototype.formatToParts);
    I.resolvedOptions = uncurried(root.Intl.DateTimeFormat.prototype.resolvedOptions);
    const NativeError = root.Error, captureStack = NativeError.captureStackTrace;
    I.installErrorRealm = NativeError;
    let activeErrorRealm = NativeError;
    const stackDescriptor = descriptor(new NativeError(), "stack");
    const nativeErrors = I.newWeakMap();
    const readStack = (error) => {
      if (stackDescriptor && stackDescriptor.get) return apply(stackDescriptor.get, error, []);
      // Older V8 uses a data property. Never invoke a page's stack getter.
      const entry = descriptor(error, "stack");
      return entry && "value" in entry ? entry.value : undefined;
    };
    const splitStack = (stack) => {
      if (typeof stack !== "string") return null;
      const start = I.methods.indexOf(stack, "\n    at ");
      return start < 0 ? null : {
        header: I.methods.slice(stack, 0, start),
        frames: I.methods.split(I.methods.slice(stack, start + 1), "\n"),
      };
    };
    let applyFrame, constructFrame, calibrating = true;
    const nativeTrace = (error, kind, errorRealm) => {
      try {
        const prepare = descriptor(NativeError, "prepareStackTrace");
        const realmPrepare = descriptor(errorRealm, "prepareStackTrace");
        // Do not eagerly invoke a page's custom stack formatter. Its output is
        // not the standard V8 string format this sanitizer operates on.
        if (prepare && (!I.hasOwn(prepare, "value") || typeof prepare.value === "function")) return;
        if (realmPrepare && (!I.hasOwn(realmPrepare, "value") || typeof realmPrepare.value === "function")) return;
        const trace = splitStack(readStack(error));
        if (!trace) return;
        let index = 0;
        while (index < trace.frames.length && I.methods.endsWith(trace.frames[index], " (<anonymous>)")) index++;
        const frame = trace.frames[index];
        if (calibrating) {
          if (kind === "apply") applyFrame = frame;
          else constructFrame = frame;
          return;
        }
        // A native error starts with zero or more native frames immediately
        // followed by OUR exact call site. A getter/callback's frame, even one
        // named nativeApply, cannot match this location. Do not rewrite it.
        if (!frame || frame !== (kind === "apply" ? applyFrame : constructFrame)) return;
        return {
          header: trace.header, prefix: I.methods.slice(trace.frames, 0, index), limit: trace.frames.length,
        };
      } catch (_) { /* Non-Error thrown values and custom stack formats pass through. */ }
    };
    const rememberError = (error, kind, errorRealm) => {
      if (calibrating) { nativeTrace(error, kind, errorRealm); return; }
      // Read/format a stack only when an exception escapes the public wrapper.
      // Internal brand probes and fallback paths often catch native exceptions.
      try { if (!I.WeakMaphas(nativeErrors, error)) I.WeakMapset(nativeErrors, error, kind); } catch (_) {}
    };
    I.nativeApply = function nativeApply(fn, receiver, args, errorRealm = activeErrorRealm) {
      try { return apply(fn, receiver, args); }
      catch (error) { rememberError(error, "apply", errorRealm); throw error; }
    };
    const construct = root.Reflect.construct;
    I.nativeConstruct = function nativeConstruct(fn, args, target = fn) {
      try { return construct(fn, args, target); }
      catch (error) { rememberError(error, "construct", activeErrorRealm); throw error; }
    };
    // Calibrate against actual native exceptions, including anonymous Via eval
    // locations. No filename or function-name blacklist is used for removal.
    try { I.nativeApply(root.Date.prototype.getTime, {}, []); } catch (_) {}
    try { I.nativeConstruct(root.Date, [root.Symbol()]); } catch (_) {}
    calibrating = false;
    I.cleanError = (error, wrapper, errorRealm = activeErrorRealm) => {
      const kind = I.WeakMapget(nativeErrors, error);
      if (!kind || !captureStack) return;
      I.WeakMapdelete(nativeErrors, error);
      const trace = nativeTrace(error, kind, errorRealm);
      if (!trace) return;
      try {
        const holder = create(null);
        const realmLimit = descriptor(errorRealm, "stackTraceLimit");
        const frameLimit = realmLimit && typeof realmLimit.value === "number"
          ? I.Math.max(0, I.Math.floor(realmLimit.value)) : trace.limit;
        // The error can belong to an iframe with a different stackTraceLimit.
        // Capture enough caller frames, restoring the root setting immediately.
        const limit = descriptor(NativeError, "stackTraceLimit");
        try {
          I.Object.defineProperty(NativeError, "stackTraceLimit", { value: frameLimit, configurable: true, writable: true });
          captureStack(holder, wrapper);
        } finally {
          if (limit) I.Object.defineProperty(NativeError, "stackTraceLimit", limit);
          else delete NativeError.stackTraceLimit;
        }
        const callers = splitStack(readStack(holder));
        const frames = I.methods.slice(callers ? I.methods.concat(trace.prefix, callers.frames) : trace.prefix, 0, frameLimit);
        const stack = trace.header + (frames.length ? "\n" + I.methods.join(frames, "\n") : "");
        if (stackDescriptor && stackDescriptor.set) apply(stackDescriptor.set, error, [stack]);
        else I.Object.defineProperty(error, "stack", { value: stack, writable: true, configurable: true });
      } catch (_) {}
    };
    I.guardMethod = (fn) => {
      const errorRealm = I.installErrorRealm;
      const wrapper = { method(...args) {
        const previous = activeErrorRealm;
        activeErrorRealm = errorRealm;
        try { return apply(fn, this, args); }
        catch (error) { I.cleanError(error, wrapper); throw error; }
        finally { activeErrorRealm = previous; }
      } }.method;
      return wrapper;
    };
    I.guardConstructor = (fn) => {
      const errorRealm = I.installErrorRealm;
      const wrapper = function (...args) {
        const previous = activeErrorRealm;
        activeErrorRealm = errorRealm;
        try { return new.target ? construct(fn, args, new.target) : apply(fn, this, args); }
        catch (error) { I.cleanError(error, wrapper); throw error; }
        finally { activeErrorRealm = previous; }
      };
      return wrapper;
    };
    I.createDefaultDateFormatter = (NativeDateTimeFormat) => {
      const formatGetter = descriptor(NativeDateTimeFormat.prototype, "format").get;
      let entries = [], lastTimezone, lastSettings;
      return (receiver, property, locales, timezone, settingsToken) => {
        let time;
        try { time = I.methods.getTime(receiver); } catch (_) { return undefined; }
        // Delegate invalid receivers/dates to the native method for its exact
        // error or Invalid Date result, before it ever inspects locales.
        if (I.Number.isNaN(time)) return undefined;
        if (timezone !== lastTimezone || settingsToken !== lastSettings) {
          entries = [];
          lastTimezone = timezone;
          lastSettings = settingsToken;
        }
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (entry.property === property && entry.locales === locales) return entry.format(time);
        }
        const options = create(null);
        options.timeZone = timezone;
        if (property !== "toLocaleTimeString") {
          options.year = options.month = options.day = "numeric";
        }
        if (property !== "toLocaleDateString") {
          options.hour = options.minute = options.second = "numeric";
        }
        let formatter;
        try { formatter = new NativeDateTimeFormat(locales, options); }
        catch (_) { return undefined; } // Native Date owns locale validation and its stack frame.
        const format = apply(formatGetter, formatter, []);
        // Bound memory even when a page cycles through many locale strings.
        if (entries.length === 32) entries = [];
        entries[entries.length] = { property, locales, format };
        return format(time);
      };
    };
    return I;
  }

  const I = captureIntrinsics(globalThis);

  const VERSION = "1.0.11";
  const STORAGE_KEY = "via-location-mask.settings.v1";
  const NETWORK_KEY = "via-location-mask.network.v1";
  const UI_STATE_KEY = "via-location-mask.ui.v1";
  const INSTANCE_MARKS_KEY = "via-location-mask.instances.v1";

  // Instances never share objects: anything handed between them could be
  // intercepted by a page that wrapped the functions involved. A re-injected
  // document is recognized through userscript storage alone, and each instance
  // keeps its own function-name registry (see createMaskedToString).
  if (!claimDocument()) return;
  const initialToString = Function.prototype.toString;
  // A toString from another realm means an ancestor frame's instance already
  // patched this realm (a Window reused for a new document).
  const realmPrePatched = !(initialToString instanceof Function);
  // Captured before page code runs; a page can shadow window.length but not
  // this native getter, and indexed child access on a WindowProxy is unhookable.
  const nativeWindowLength = I.Object.getOwnPropertyDescriptor(window, "length").get;
  const nativeFunctionSource = I.nativeApply(initialToString, Function, []);
  const DEFAULT_SETTINGS = I.Object.freeze({
    enabled: false,
    latitude: 25.033,
    longitude: 121.5654,
    accuracy: 30,
    approximateEnabled: false,
    approximateRadius: 500,
    approximateSeed: 0,
    preservePermissionPrompt: false,
    localeEnabled: false,
    language: "zh-CN",
    languages: ["zh-CN", "en-US"],
    timezoneEnabled: false,
    timezone: "Asia/Taipei",
    workerEnabled: true,
    patchUrlWorkers: false,
    siteMode: "all",
    sitePatterns: [],
    profiles: [],
    vpnAutoSync: false,
    vpnCheckMinutes: 15,
    floatingButtonEnabled: false,
    debug: false,
  });

  // Capture the entropy source before page code can wrap it. Do not consume
  // the page's observable Math.random stream, even as a fallback.
  const randomFill = window.crypto && typeof window.crypto.getRandomValues === "function"
    ? I.bind(window.crypto.getRandomValues, window.crypto) : null;
  const randomBuffer = new Uint32Array(2);
  function randomUnit() {
    if (!randomFill) return 0.5;
    randomFill(randomBuffer);
    return ((randomBuffer[0] >>> 5) * 67108864 + (randomBuffer[1] >>> 6)) / 9007199254740992;
  }
  const coveredIframeRealms = I.newWeakSet();
  const iframeObserverApis = I.newWeakMap();
  const observedIframeDocuments = I.newWeakSet();
  const watchedIframes = I.newWeakSet();
  const trackedWorkerBlobs = I.newMap();
  const sharedWorkerUrls = I.newMap();

  const originals = {
    functionToString: initialToString,
    functionCall: Function.prototype.call,
  };
  const overrideRegistry = I.newWeakMap();
  const patchedRealms = I.newWeakSet();
  // Genuine Function.prototype objects of same-origin realms in this tab. Masks
  // only look for another instance's mask on these, never on arbitrary
  // (possibly proxied) prototypes a page can attach to its own functions.
  const knownRealms = I.newWeakSet([Function.prototype]);
  // Source text shared by every mask this script version installs; used to
  // recognize masks without ever calling page code. When an ancestor's mask
  // is already installed here it still reports this unregistered function's
  // real source.
  const maskSource = I.nativeApply(
    initialToString,
    createMaskedToString(initialToString, "", ""),
    []
  );
  const syntheticWatchStops = I.newSet();
  const coordsSlots = I.newWeakMap();
  const positionSlots = I.newWeakMap();
  let paddedCoordinateCache = null;
  let settings = readSettings();

  function claimDocument() {
    try {
      if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function") return true;
      // Hashed so the marks never keep a readable browsing history.
      const key = hashText(location.href + "|" + performance.timeOrigin);
      const saved = GM_getValue(INSTANCE_MARKS_KEY, null);
      const marks = I.Array.isArray(saved) ? saved : typeof saved === "string" ? I.JSON.parse(saved) : [];
      if (!I.Array.isArray(marks)) return true;
      if (I.methods.includes(marks, key)) return false;
      GM_setValue(INSTANCE_MARKS_KEY, I.JSON.stringify(I.methods.slice(I.methods.concat([key], marks), 0, 200)));
    } catch (_) {
      // Without a mark a re-injection only layers a second, still consistent patch.
    }
    return true;
  }

  function hashText(text) {
    let first = 0xdeadbeef;
    let second = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
      const code = I.methods.charCodeAt(text, index);
      first = I.Math.imul(first ^ code, 2654435761);
      second = I.Math.imul(second ^ code, 1597334677);
    }
    first = I.Math.imul(first ^ (first >>> 16), 2246822507) ^ I.Math.imul(second ^ (second >>> 13), 3266489909);
    second = I.Math.imul(second ^ (second >>> 16), 2246822507) ^ I.Math.imul(first ^ (first >>> 13), 3266489909);
    return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36);
  }

  // Masks the realm's Function.prototype.toString. Wrappers registered by
  // another instance (for example one running inside a same-origin frame) are
  // not in this registry, so they are named by the mask on the wrapper's own
  // realm, after that mask is recognized by its native source text.
  function createMaskedToString(nativeToString, nativePrefix, nativeSuffix) {
    let delegating = false;
    const errorRealm = I.installErrorRealm;
    const maskedToString = {
      toString() {
        try {
          const name = I.WeakMapget(overrideRegistry, this);
          if (name !== undefined) return nativePrefix + name + nativeSuffix;
          const source = I.nativeApply(nativeToString, this, [], errorRealm);
          // Native functions, bound functions and proxies need no lookup, and
          // skipping them keeps proxy traps from observing the calls below.
          if (delegating || !maskSource || I.methods.test(/\[native code\]\s*\}$/, source)) return source;
          const prototype = I.Reflect.getPrototypeOf(this);
          // Frames (siblings included) may have appeared since the last walk.
          if (!I.WeakSethas(knownRealms, prototype)) discoverRealms();
          if (!I.WeakSethas(knownRealms, prototype)) return source;
          const descriptor = I.Reflect.getOwnPropertyDescriptor(prototype, "toString");
          const owner = descriptor && descriptor.value;
          if (typeof owner !== "function" || owner === maskedToString ||
              I.nativeApply(nativeToString, owner, []) !== maskSource) return source;
          delegating = true;
          try {
            return I.nativeApply(owner, this, []);
          } finally {
            delegating = false;
          }
        } catch (error) { I.cleanError(error, maskedToString, errorRealm); throw error; }
      },
    }.toString;
    return maskedToString;
  }

  // Reads a window's Function.prototype without running page code: the
  // property is read as a descriptor, and the constructor must be the genuine
  // native Function (a proxy or page function stringifies differently).
  function genuineFunctionPrototype(realm) {
    try {
      const descriptor = I.Reflect.getOwnPropertyDescriptor(realm, "Function");
      const constructor = descriptor && descriptor.value;
      if (typeof constructor !== "function" ||
          I.nativeApply(initialToString, constructor, []) !== nativeFunctionSource) return null;
      const prototypeDescriptor = I.Reflect.getOwnPropertyDescriptor(constructor, "prototype");
      return prototypeDescriptor ? prototypeDescriptor.value : null;
    } catch (_) {
      return null;  // Cross-origin.
    }
  }

  // Records every same-origin realm in the tab, walking the frame tree from
  // the unforgeable window.top through cross-origin frames as well.
  function discoverRealms() {
    const visit = (frame, depth) => {
      const prototype = genuineFunctionPrototype(frame);
      if (prototype) I.WeakSetadd(knownRealms, prototype);
      if (depth > 32) return;
      let count = 0;
      try {
        count = I.nativeApply(nativeWindowLength, frame, []);
      } catch (_) {
        return;
      }
      for (let index = 0; index < count; index += 1) {
        let child;
        try {
          child = frame[index];
        } catch (_) {
          continue;
        }
        if (child) visit(child, depth + 1);
      }
    };
    try {
      visit(window.top, 0);
    } catch (_) {
      // Keep whatever was recorded.
    }
  }

  function realmMasked(functionPrototype) {
    const descriptor = I.Reflect.getOwnPropertyDescriptor(functionPrototype, "toString");
    const current = descriptor && descriptor.value;
    if (typeof current !== "function") return false;
    if (I.WeakMaphas(overrideRegistry, current)) return true;
    return !!maskSource && I.nativeApply(initialToString, current, []) === maskSource;
  }

  function log(...args) {
    if (settings.debug) I.nativeApply(console.debug, console, I.methods.concat(["[Via Location Mask]"], args));
  }

  function finiteNumber(value, fallback) {
    const number = typeof value === "number" ? value : I.NumberCtor(value);
    return I.Number.isFinite(number) ? number : fallback;
  }

  function randomSeed() {
    return I.Math.floor(randomUnit() * 0xffffffff) + 1;
  }

  function canonicalLanguage(value, fallback) {
    try {
      return Intl.getCanonicalLocales(I.methods.trim(I.StringCtor(value || "")))[0] || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function canonicalTimezone(value, fallback) {
    try {
      return I.resolvedOptions(new Intl.DateTimeFormat("en-US", {
        timeZone: I.methods.trim(I.StringCtor(value || "")),
      })).timeZone;
    } catch (_) {
      return fallback;
    }
  }

  function normalizeLanguageList(primary, input) {
    const raw = I.Array.isArray(input)
      ? input
      : typeof input === "string"
        ? I.methods.split(input, /[,\s]+/)
        : [];
    const result = [];
    for (let _index1 = 0, _items1 = I.list(I.methods.concat([primary], raw)); _index1 < _items1.length; _index1++) {
      const item = _items1[_index1];
      const canonical = canonicalLanguage(item, "");
      if (canonical && !I.methods.includes(result, canonical)) I.methods.push(result, canonical);
    }
    return result.length ? result : [primary];
  }

  function normalizeProfile(input, index) {
    if (!input || typeof input !== "object") return null;
    const name = I.methods.slice(I.methods.trim(I.StringCtor(input.name || "配置档 " + (index + 1))), 0, 40);
    if (!name) return null;
    const language = canonicalLanguage(input.language, DEFAULT_SETTINGS.language);
    return {
      name,
      latitude: I.Math.max(-90, I.Math.min(90, finiteNumber(input.latitude, DEFAULT_SETTINGS.latitude))),
      longitude: I.Math.max(
        -180,
        I.Math.min(180, finiteNumber(input.longitude, DEFAULT_SETTINGS.longitude))
      ),
      accuracy: I.Math.max(
        1,
        I.Math.min(100000, I.Math.round(finiteNumber(input.accuracy, DEFAULT_SETTINGS.accuracy)))
      ),
      language,
      languages: normalizeLanguageList(language, input.languages),
      timezone: canonicalTimezone(input.timezone, DEFAULT_SETTINGS.timezone),
    };
  }

  function escapePatternText(value) {
    return I.methods.replace(value, /[.*+?^{}()|[\]\\$]/g, "\\$&");
  }

  function parseSitePattern(input) {
    const source = I.methods.trim(I.StringCtor(input || ""));
    if (!source || I.methods.includes(source, "?") || I.methods.includes(source, "#") || I.methods.includes(source, "\\")) {
      return null;
    }
    let rest = source;
    let scheme = null;
    const schemeMatch = I.methods.exec(/^(\*|https?):\/\//i, rest);
    if (schemeMatch) {
      scheme = I.methods.toLowerCase(schemeMatch[1]);
      rest = I.methods.slice(rest, schemeMatch[0].length);
    } else if (I.methods.includes(rest, "://")) {
      return null;
    }
    const slash = I.methods.indexOf(rest, "/");
    let hostPort = slash === -1 ? rest : I.methods.slice(rest, 0, slash);
    let pathPattern = slash === -1 ? null : I.methods.slice(rest, slash);
    if (pathPattern === "/") pathPattern = null;
    let port = null;
    const portMatch = I.methods.exec(/:(\*|\d+)$/, hostPort);
    if (portMatch) {
      port = portMatch[1] === "*" ? null : portMatch[1];
      hostPort = I.methods.slice(hostPort, 0, -portMatch[0].length);
      if (port && (I.NumberCtor(port) < 1 || I.NumberCtor(port) > 65535)) return null;
    }
    let host = I.methods.toLowerCase(hostPort);
    const subdomainsOnly = I.methods.startsWith(host, "*.");
    if (subdomainsOnly) host = I.methods.slice(host, 2);
    const anyHost = host === "*";
    const ipv6 = I.methods.startsWith(host, "[") && I.methods.endsWith(host, "]");
    if (!host || (!anyHost && I.methods.includes(host, "*")) || (!ipv6 && I.methods.includes(host, ":"))) return null;
    if (ipv6 && subdomainsOnly) return null;
    let exactHostOnly = false;
    if (!anyHost) {
      try {
        const parsedHost = new URL("http://" + host);
        if (parsedHost.username || parsedHost.password || parsedHost.port) return null;
        host = I.methods.toLowerCase(parsedHost.hostname);
      } catch (_) {
        return null;
      }
      const ipv4 = I.methods.test(/^(?:\d{1,3}\.){3}\d{1,3}$/, host);
      exactHostOnly = ipv4 || ipv6 || !I.methods.includes(host, ".");
    }
    if (pathPattern && !I.methods.startsWith(pathPattern, "/")) return null;
    const pathRegex = pathPattern
      ? new I.RegExp("^" + I.methods.join(I.methods.map(I.methods.split(pathPattern, "*"), escapePatternText), ".*") + "$")
      : null;
    return {
      source, scheme, host, subdomainsOnly, anyHost, exactHostOnly, port, pathRegex,
    };
  }

  function sitePatternMatches(pattern, url) {
    const parsed = parseSitePattern(pattern);
    if (!parsed) return false;
    let target;
    try {
      target = new URL(url);
    } catch (_) {
      return false;
    }
    const protocol = I.methods.toLowerCase(I.methods.slice(target.protocol, 0, -1));
    if (!I.methods.includes(["http", "https"], protocol)) return false;
    if (parsed.scheme && parsed.scheme !== "*" && parsed.scheme !== protocol) return false;
    const hostname = I.methods.toLowerCase(target.hostname);
    const hostMatches = parsed.anyHost ||
      (parsed.subdomainsOnly
        ? I.methods.endsWith(hostname, "." + parsed.host)
        : hostname === parsed.host ||
          (!parsed.exactHostOnly && I.methods.endsWith(hostname, "." + parsed.host)));
    if (!hostMatches) return false;
    if (parsed.port !== null) {
      const effectivePort = target.port || (protocol === "https" ? "443" : "80");
      if (effectivePort !== parsed.port) return false;
    }
    return !parsed.pathRegex || I.methods.test(parsed.pathRegex, target.pathname);
  }

  function siteRuleForUrl(url) {
    try {
      const target = new URL(url);
      if (!I.methods.includes(["http:", "https:"], target.protocol)) return "";
      return I.methods.toLowerCase(target.hostname) + (target.port ? ":" + target.port : "");
    } catch (_) {
      return "";
    }
  }

  function protectionActive() {
    if (!settings.enabled) return false;
    if (settings.siteMode === "all") return true;
    const matched = I.methods.some(settings.sitePatterns, (pattern) =>
      sitePatternMatches(pattern, location.href));
    return settings.siteMode === "allowlist" ? matched : !matched;
  }

  function validateSettings(input) {
    const raw = input && typeof input === "object" ? input : {};
    const language = canonicalLanguage(raw.language, DEFAULT_SETTINGS.language);
    const rawLanguages = I.Array.isArray(raw.languages)
      ? raw.languages
      : typeof raw.languages === "string"
        ? I.methods.split(raw.languages, /[,\s]+/)
        : DEFAULT_SETTINGS.languages;
    const languages = normalizeLanguageList(language, rawLanguages);
    const timezone = canonicalTimezone(raw.timezone, DEFAULT_SETTINGS.timezone);
    const siteMode = I.methods.includes(["all", "allowlist", "denylist"], raw.siteMode)
      ? raw.siteMode
      : "all";
    const sitePatterns = I.Array.isArray(raw.sitePatterns)
      ? I.methods.slice(I.methods.filter(I.Array.from(I.newSet(I.methods.map(raw.sitePatterns, (value) => I.methods.trim(I.StringCtor(value))))), (value) => parseSitePattern(value)), 0, 200)
      : [];
    const profiles = [];
    const profileNames = I.newSet();
    if (I.Array.isArray(raw.profiles)) {
      for (let index = 0; index < raw.profiles.length && profiles.length < 30; index += 1) {
        const profile = normalizeProfile(raw.profiles[index], index);
        if (!profile || I.Sethas(profileNames, profile.name)) continue;
        I.Setadd(profileNames, profile.name);
        I.methods.push(profiles, profile);
      }
    }
    return {
      enabled: raw.enabled === true,
      latitude: I.Math.max(
        -90,
        I.Math.min(90, finiteNumber(raw.latitude, DEFAULT_SETTINGS.latitude))
      ),
      longitude: I.Math.max(
        -180,
        I.Math.min(180, finiteNumber(raw.longitude, DEFAULT_SETTINGS.longitude))
      ),
      accuracy: I.Math.max(
        1,
        I.Math.min(100000, I.Math.round(finiteNumber(raw.accuracy, DEFAULT_SETTINGS.accuracy)))
      ),
      approximateEnabled: raw.approximateEnabled === true,
      approximateRadius: I.Math.max(
        50,
        I.Math.min(50000, I.Math.round(finiteNumber(raw.approximateRadius, 500)))
      ),
      approximateSeed:
        I.Number.isInteger(raw.approximateSeed) && raw.approximateSeed > 0
          ? raw.approximateSeed >>> 0 || 1
          : randomSeed(),
      preservePermissionPrompt: raw.preservePermissionPrompt === true,
      localeEnabled: raw.localeEnabled === true,
      language,
      languages: languages.length ? languages : [language],
      timezoneEnabled: raw.timezoneEnabled === true,
      timezone,
      workerEnabled: raw.workerEnabled !== false,
      patchUrlWorkers: raw.patchUrlWorkers === true,
      siteMode,
      sitePatterns,
      profiles,
      vpnAutoSync: raw.vpnAutoSync === true,
      vpnCheckMinutes: I.Math.max(
        5,
        I.Math.min(1440, I.Math.round(finiteNumber(raw.vpnCheckMinutes, 15)))
      ),
      floatingButtonEnabled: raw.floatingButtonEnabled === true,
      debug: raw.debug === true,
    };
  }

  function readSettings() {
    try {
      if (typeof GM_getValue !== "function") return { ...DEFAULT_SETTINGS };
      const saved = GM_getValue(STORAGE_KEY, null);
      if (saved == null) return { ...DEFAULT_SETTINGS };
      if (typeof saved === "string") return validateSettings(I.JSON.parse(saved));
      return validateSettings(saved);
    } catch (error) {
      console.warn("[Via Location Mask] Could not read settings:", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(next) {
    const validated = validateSettings(next);
    if (typeof GM_setValue === "function") {
      GM_setValue(STORAGE_KEY, I.JSON.stringify(validated));
    }
    settings = validated;
    paddedCoordinateCache = null;
    if (!protectionActive()) stopAllSyntheticWatches();
    return validated;
  }

  function hasSavedSettings() {
    try {
      return typeof GM_getValue === "function" && GM_getValue(STORAGE_KEY, null) != null;
    } catch (_) {
      return false;
    }
  }

  function readUiState() {
    const fallback = { onboardingSeen: false };
    try {
      if (typeof GM_getValue !== "function") return fallback;
      const saved = GM_getValue(UI_STATE_KEY, null);
      const parsed = typeof saved === "string" ? I.JSON.parse(saved) : saved;
      return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveUiState(next) {
    if (typeof GM_setValue === "function") {
      GM_setValue(UI_STATE_KEY, I.JSON.stringify(next));
    }
  }

  function readNetworkState() {
    const fallback = {
      cityCache: {},
      timezoneCache: {},
      ipGeoCache: {},
      lastIp: "",
      lastIpCheckAt: 0,
      lastSyncAt: 0,
      lastSyncLabel: "",
      lastError: "",
      geocoderAt: 0,
    };
    try {
      if (typeof GM_getValue !== "function") return fallback;
      const saved = GM_getValue(NETWORK_KEY, null);
      const parsed = typeof saved === "string" ? I.JSON.parse(saved) : saved;
      return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveNetworkState(state) {
    if (typeof GM_setValue === "function") {
      GM_setValue(NETWORK_KEY, I.JSON.stringify(state));
    }
  }

  function trimCache(cache, maximumEntries) {
    const entries = I.methods.sort(I.Object.entries(cache || {}), (left, right) =>
      finiteNumber(right[1] && right[1].cachedAt, 0) -
      finiteNumber(left[1] && left[1].cachedAt, 0));
    return I.Object.fromEntries(I.methods.slice(entries, 0, maximumEntries));
  }

  function wait(milliseconds) {
    return new I.Promise((resolve) => I.setTimeout(resolve, milliseconds));
  }

  function requestText(url, options = {}) {
    const timeout = finiteNumber(options.timeout, 8000);
    const headers = { Accept: options.accept || "application/json" };
    if (typeof GM_xmlhttpRequest === "function") {
      return new I.Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers,
          timeout,
          anonymous: true,
          onload(response) {
            if (response.status >= 200 && response.status < 300) {
              resolve(response.responseText || "");
            } else {
              reject(new Error("HTTP " + response.status));
            }
          },
          ontimeout() {
            reject(new Error("请求超时"));
          },
          onerror(response) {
            reject(new Error(response && response.error || "网络请求失败"));
          },
          onabort() {
            reject(new Error("请求已取消"));
          },
        });
      });
    }
    const controller = new AbortController();
    const timer = I.setTimeout(() => controller.abort(), timeout);
    return fetch(url, { headers, credentials: "omit", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .finally(() => I.clearTimeout(timer));
  }

  async function requestJson(url, options) {
    const text = await requestText(url, options);
    try {
      return I.JSON.parse(text);
    } catch (_) {
      throw new Error("服务返回了无效 JSON");
    }
  }

  function validCoordinates(latitude, longitude) {
    return I.Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      I.Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  }

  async function searchCities(query) {
    const normalized = I.methods.trim(I.StringCtor(query || ""));
    if (normalized.length < 3) throw new Error("请至少输入 3 个字符。");
    const cacheKey = "open-meteo:" + normalized.toLocaleLowerCase("en-US") + ":" +
      I.StringCtor(settings.language || "zh-CN").toLocaleLowerCase("en-US");
    let network = readNetworkState();
    const cached = network.cityCache && network.cityCache[cacheKey];
    if (cached && I.dateNow() - cached.cachedAt < 7 * 24 * 60 * 60 * 1000) {
      return { results: cached.results, cached: true };
    }
    const sinceLast = I.dateNow() - finiteNumber(network.geocoderAt, 0);
    if (sinceLast < 1100) await wait(1100 - sinceLast);
    network = readNetworkState();
    network.geocoderAt = I.dateNow();
    saveNetworkState(network);
    const parameters = new URLSearchParams({
      name: normalized,
      count: "10",
      language: I.methods.toLowerCase(I.methods.split(I.StringCtor(settings.language || "zh-CN"), "-")[0]),
      format: "json",
    });
    const data = await requestJson(
      "https://geocoding-api.open-meteo.com/v1/search?" + parameters,
      { timeout: 8000 }
    );
    if (!data || !I.Array.isArray(data.results)) {
      if (data && data.results == null) return { results: [], cached: false };
      throw new Error("城市搜索返回格式无效。");
    }
    const results = I.methods.slice(I.methods.filter(I.methods.map(data.results, (item) => {
      const latitude = I.NumberCtor(item.latitude);
      const longitude = I.NumberCtor(item.longitude);
      const city = I.StringCtor(item.name || "");
      const country = I.StringCtor(item.country || item.country_code || "");
      const area = I.StringCtor(item.admin1 || "");
      const name = I.methods.join(I.methods.filter([city, area, country], (value, index, values) =>
        value && I.methods.indexOf(values, value) === index), ", ");
      return {
        name: name || city || country,
        city,
        country,
        latitude,
        longitude,
        timezone: canonicalTimezone(item.timezone, ""),
      };
    }), (item) => validCoordinates(item.latitude, item.longitude)), 0, 5);
    network = readNetworkState();
    network.cityCache = trimCache({
      ...(network.cityCache || {}),
      [cacheKey]: { results, cachedAt: I.dateNow() },
    }, 40);
    saveNetworkState(network);
    return { results, cached: false };
  }

  async function resolveTimezone(latitude, longitude, hint) {
    const hinted = canonicalTimezone(hint, "");
    if (hinted) return { timezone: hinted, source: "IP 服务" };
    const key = I.methods.toFixed(I.NumberCtor(latitude), 4) + "," + I.methods.toFixed(I.NumberCtor(longitude), 4);
    let network = readNetworkState();
    const cached = network.timezoneCache && network.timezoneCache[key];
    if (cached && I.dateNow() - cached.cachedAt < 30 * 24 * 60 * 60 * 1000) {
      return { timezone: cached.timezone, source: "缓存" };
    }
    const parameters = new URLSearchParams({
      latitude: I.StringCtor(latitude),
      longitude: I.StringCtor(longitude),
    });
    const data = await requestJson(
      "https://timeapi.io/api/timezone/coordinate?" + parameters,
      { timeout: 8000 }
    );
    const timezone = canonicalTimezone(data && data.timeZone, "");
    if (!timezone) throw new Error("无法为该坐标确定 IANA 时区。");
    network = readNetworkState();
    network.timezoneCache = trimCache({
      ...(network.timezoneCache || {}),
      [key]: { timezone, cachedAt: I.dateNow() },
    }, 100);
    saveNetworkState(network);
    return { timezone, source: "TimeAPI.io" };
  }

  function isValidIpAddress(value) {
    const ip = I.methods.trim(I.StringCtor(value || ""));
    const ipv4 = I.methods.exec(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, ip);
    if (ipv4) return I.methods.every(I.methods.slice(ipv4, 1), (part) => I.NumberCtor(part) <= 255);
    return I.methods.test(/^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i, ip);
  }

  const IP_PROVIDERS = [
    { name: "ipify", url: "https://api64.ipify.org/", parse: (body) => I.methods.trim(body) },
    { name: "ident.me", url: "https://ident.me/", parse: (body) => I.methods.trim(body) },
    { name: "ifconfig.me", url: "https://ifconfig.me/ip", parse: (body) => I.methods.trim(body) },
    { name: "icanhazip", url: "https://icanhazip.com/", parse: (body) => I.methods.trim(body) },
  ];

  async function detectPublicIp() {
    const failures = [];
    for (let _index2 = 0, _items2 = I.list(IP_PROVIDERS); _index2 < _items2.length; _index2++) {
      const provider = _items2[_index2];
      try {
        const body = await requestText(provider.url, { timeout: 8000 });
        const ip = provider.parse(body);
        if (!isValidIpAddress(ip)) throw new Error("无效 IP");
        return { ip, provider: provider.name };
      } catch (error) {
        I.methods.push(failures, provider.name + ": " + (error && error.message || error));
      }
    }
    throw new Error("公网 IP 查询失败（" + I.methods.join(failures, "；") + "）");
  }

  function normalizeIpGeo(data) {
    if (!data || typeof data !== "object") return null;
    const latitude = I.NumberCtor(data.latitude);
    const longitude = I.NumberCtor(data.longitude);
    const ip = I.methods.trim(I.StringCtor(data.ip || data.ipAddress || ""));
    if (!validCoordinates(latitude, longitude) || !isValidIpAddress(ip)) return null;
    const rawZones = I.Array.isArray(data.timeZones) && data.timeZones.length === 1
      ? data.timeZones[0]
      : data.timezone || data.time_zone || data.timeZone;
    return {
      latitude,
      longitude,
      ip,
      city: I.StringCtor(data.city || data.cityName || ""),
      country: I.StringCtor(data.country || data.countryName || data.country_name || data.countryCode || ""),
      timezone: canonicalTimezone(rawZones, ""),
    };
  }

  async function geolocateIp(ip) {
    let network = readNetworkState();
    const cached = network.ipGeoCache && network.ipGeoCache[ip];
    if (cached && I.dateNow() - cached.cachedAt < 30 * 24 * 60 * 60 * 1000) {
      return { ...cached.result, provider: "缓存" };
    }
    const services = [
      {
        name: "FreeIPAPI",
        url: "https://free.freeipapi.com/api/json/" + encodeURIComponent(ip),
        transform: normalizeIpGeo,
      },
      {
        name: "GeoJS",
        url: "https://get.geojs.io/v1/ip/geo/" + encodeURIComponent(ip) + ".json",
        transform: normalizeIpGeo,
      },
      {
        name: "ReallyFreeGeoIP",
        url: "https://reallyfreegeoip.org/json/" + encodeURIComponent(ip),
        transform: normalizeIpGeo,
      },
      {
        name: "ipinfo",
        url: "https://ipinfo.io/" + encodeURIComponent(ip) + "/json",
        transform(data) {
          const parts = I.methods.split(I.StringCtor(data && data.loc || ""), ",");
          return normalizeIpGeo({
            ...data,
            latitude: I.NumberCtor(parts[0]),
            longitude: I.NumberCtor(parts[1]),
            country: data && data.country,
          });
        },
      },
    ];
    const failures = [];
    for (let _index3 = 0, _items3 = I.list(services); _index3 < _items3.length; _index3++) {
      const service = _items3[_index3];
      try {
        const data = await requestJson(service.url, { timeout: 7000 });
        const result = service.transform(data);
        if (!result) throw new Error("响应字段无效");
        if (result.ip !== ip && I.methods.includes(ip, ".")) throw new Error("响应 IP 不一致");
        network = readNetworkState();
        network.ipGeoCache = trimCache({
          ...(network.ipGeoCache || {}),
          [ip]: { result, cachedAt: I.dateNow() },
        }, 50);
        saveNetworkState(network);
        return { ...result, provider: service.name };
      } catch (error) {
        I.methods.push(failures, service.name + ": " + (error && error.message || error));
      }
    }
    throw new Error("IP 地理位置解析失败（" + I.methods.join(failures, "；") + "）");
  }

  async function getVpnLocation() {
    const detected = await detectPublicIp();
    const geo = await geolocateIp(detected.ip);
    return { ...geo, ipProvider: detected.provider };
  }

  function applyVpnLocation(result) {
    const next = {
      ...settings,
      latitude: result.latitude,
      longitude: result.longitude,
    };
    if (result.timezone) {
      next.timezone = result.timezone;
      next.timezoneEnabled = true;
    }
    saveSettings(next);
    const network = readNetworkState();
    network.lastIp = result.ip;
    network.lastIpCheckAt = I.dateNow();
    network.lastSyncAt = I.dateNow();
    network.lastSyncLabel = I.methods.join(I.methods.filter([result.city, result.country], I.BooleanCtor), ", ") || result.ip;
    network.lastError = "";
    saveNetworkState(network);
    return next;
  }

  let autoSyncInFlight = null;
  async function runAutoVpnCheck(reason) {
    const current = readSettings();
    settings = current;
    if (!current.vpnAutoSync || autoSyncInFlight) return;
    const network = readNetworkState();
    if (I.dateNow() - finiteNumber(network.lastIpCheckAt, 0) < 10000) return;
    autoSyncInFlight = (async () => {
      try {
        const first = await detectPublicIp();
        let state = readNetworkState();
        state.lastIpCheckAt = I.dateNow();
        saveNetworkState(state);
        if (state.lastIp && state.lastIp === first.ip) return;
        await wait(2500);
        const confirmed = await detectPublicIp();
        if (confirmed.ip !== first.ip) return;
        const result = await geolocateIp(confirmed.ip);
        applyVpnLocation({ ...result, ipProvider: confirmed.provider });
        log("VPN auto-sync applied", { reason, ip: confirmed.ip });
      } catch (error) {
        const state = readNetworkState();
        state.lastError = I.methods.slice(I.StringCtor(error && error.message || error), 0, 500);
        state.lastIpCheckAt = I.dateNow();
        saveNetworkState(state);
        log("VPN auto-sync failed", error);
      }
    })().finally(() => {
      autoSyncInFlight = null;
    });
    return autoSyncInFlight;
  }

  function installAutoVpnSync() {
    if (!settings.vpnAutoSync) return;
    I.setTimeout(() => runAutoVpnCheck("page-open"), 1500);
    const interval = I.Math.max(5, settings.vpnCheckMinutes) * 60 * 1000;
    setInterval(() => runAutoVpnCheck("interval"), interval);
    addEventListener("online", () => runAutoVpnCheck("online"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") runAutoVpnCheck("foreground");
    });
    addEventListener("pageshow", () => runAutoVpnCheck("pageshow"));
  }

  function registerOverride(fn, nativeName) {
    I.WeakMapset(overrideRegistry, fn, nativeName);
  }

  function callOriginalToString(fn) {
    return I.nativeApply(originals.functionToString, fn, []);
  }

  function isConstructible(fn) {
    if (typeof fn !== "function") return false;
    try {
      I.nativeConstruct(new I.Proxy(fn, { construct: () => ({}) }), []);
      return true;
    } catch (_) {
      return false;
    }
  }

  function stripConstruct(fn) {
    return I.guardMethod(fn);
  }

  function disguiseAsNative(fn, nativeName, expectedLength) {
    I.Object.defineProperty(fn, "length", {
      value: expectedLength,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    I.Object.defineProperty(fn, "name", {
      value: nativeName,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    const prototypeDescriptor = I.Object.getOwnPropertyDescriptor(fn, "prototype");
    if (prototypeDescriptor && prototypeDescriptor.configurable) delete fn.prototype;
  }

  function installOverride(target, property, implementation, forcedLength) {
    if (!target) return null;
    const descriptor = I.Object.getOwnPropertyDescriptor(target, property);
    const original = descriptor && descriptor.value;
    const expectedLength =
      forcedLength == null && typeof original === "function"
        ? original.length
        : forcedLength == null
          ? 0
          : forcedLength;
    let finalFunction = implementation;
    if (!isConstructible(original)) {
      finalFunction = stripConstruct(implementation);
    }
    registerOverride(finalFunction, property);
    disguiseAsNative(finalFunction, property, expectedLength);
    I.Object.defineProperty(target, property, {
      value: finalFunction,
      configurable: descriptor ? descriptor.configurable : true,
      enumerable: descriptor ? descriptor.enumerable : false,
      writable: descriptor ? descriptor.writable : true,
    });
    return finalFunction;
  }

  function accessorMaskName(kind, property) {
    try {
      const nativeGetter = I.Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
      return I.methods.includes(callOriginalToString(nativeGetter), "get size")
        ? `${kind} ${property}`
        : property;
    } catch (_) {
      return `${kind} ${property}`;
    }
  }

  function installAccessor(target, property, accessors) {
    const original = I.Object.getOwnPropertyDescriptor(target, property);
    if (!original) return false;
    const descriptor = {
      configurable: original.configurable,
      enumerable: original.enumerable,
    };
    if (accessors.get) {
      const getter = stripConstruct(accessors.get);
      registerOverride(getter, accessorMaskName("get", property));
      disguiseAsNative(getter, `get ${property}`, 0);
      descriptor.get = getter;
    } else if (original.get) {
      descriptor.get = original.get;
    }
    if (accessors.set) {
      const setter = stripConstruct(accessors.set);
      registerOverride(setter, accessorMaskName("set", property));
      disguiseAsNative(setter, `set ${property}`, 1);
      descriptor.set = setter;
    } else if (original.set) {
      descriptor.set = original.set;
    }
    I.Object.defineProperty(target, property, descriptor);
    return true;
  }

  function installFunctionMaskingOn(realm) {
    const functionPrototype = realm.Function.prototype;
    const nativeToString = functionPrototype.toString;
    const numberSource = I.nativeApply(nativeToString, realm.Number, []);
    const split = I.methods.split(numberSource, "Number");
    const nativePrefix = split[0] || "function ";
    const nativeSuffix = split[1] || "() { [native code] }";
    const maskedToString = createMaskedToString(nativeToString, nativePrefix, nativeSuffix);
    registerOverride(maskedToString, "toString");
    disguiseAsNative(maskedToString, "toString", 0);
    functionPrototype.toString = maskedToString;
  }

  function coordinateHash01(seed, latitude, longitude, salt) {
    const key = seed + "|" + salt + "|" + latitude + "|" + longitude;
    let hash = 1779033703 ^ key.length;
    for (let index = 0; index < key.length; index += 1) {
      hash = I.Math.imul(hash ^ I.methods.charCodeAt(key, index), 3432918353);
      hash = (hash << 13) | (hash >>> 19);
    }
    hash = I.Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = I.Math.imul(hash ^ (hash >>> 13), 3266489909);
    hash ^= hash >>> 16;
    let mixed = (hash + 0x6d2b79f5) | 0;
    mixed = I.Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + I.Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  function wrapLongitude(longitude) {
    if (longitude >= -180 && longitude < 180) return longitude;
    return (((longitude + 180) % 360) + 360) % 360 - 180;
  }

  function resolveReportedCoordinates(latitude, longitude, enabled, radius, seed) {
    const anchorLatitude = I.Math.max(-90, I.Math.min(90, finiteNumber(latitude, 0)));
    const anchorLongitude = wrapLongitude(finiteNumber(longitude, 0));
    if (!enabled) {
      return { latitude: anchorLatitude, longitude: anchorLongitude };
    }
    const safeRadius = I.Math.max(50, I.Math.min(50000, finiteNumber(radius, 500)));
    const distance = safeRadius * I.Math.sqrt(
      coordinateHash01(seed, anchorLatitude, anchorLongitude, 0x9e3779b9)
    );
    const bearing = 2 * I.Math.PI *
      coordinateHash01(seed, anchorLatitude, anchorLongitude, 0x85ebca6b);
    const earthRadius = 6371000;
    const north = distance * I.Math.cos(bearing);
    const east = distance * I.Math.sin(bearing);
    const latitudeOffset = north / earthRadius * 180 / I.Math.PI;
    const cosine = I.Math.cos(anchorLatitude * I.Math.PI / 180);
    const longitudeOffset = I.Math.abs(cosine) < 1e-12
      ? 0
      : east / (earthRadius * cosine) * 180 / I.Math.PI;
    return {
      latitude: I.Math.max(-90, I.Math.min(90, anchorLatitude + latitudeOffset)),
      longitude: wrapLongitude(anchorLongitude + longitudeOffset),
    };
  }

  const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

  function decodeGeohash(value) {
    const geohash = I.methods.toLowerCase(I.methods.trim(I.StringCtor(value || "")));
    if (!I.methods.test(/^[0123456789bcdefghjkmnpqrstuvwxyz]{5,12}$/, geohash) ||
        !I.methods.test(/[b-z]/, geohash)) return null;
    let latitudeMin = -90;
    let latitudeMax = 90;
    let longitudeMin = -180;
    let longitudeMax = 180;
    let longitudeBit = true;
    for (let _index4 = 0, _items4 = I.list(geohash); _index4 < _items4.length; _index4++) {
      const character = _items4[_index4];
      const number = I.methods.indexOf(GEOHASH_ALPHABET, character);
      if (number < 0) return null;
      for (let mask = 16; mask > 0; mask >>= 1) {
        if (longitudeBit) {
          const middle = (longitudeMin + longitudeMax) / 2;
          if (number & mask) longitudeMin = middle;
          else longitudeMax = middle;
        } else {
          const middle = (latitudeMin + latitudeMax) / 2;
          if (number & mask) latitudeMin = middle;
          else latitudeMax = middle;
        }
        longitudeBit = !longitudeBit;
      }
    }
    return {
      latitude: (latitudeMin + latitudeMax) / 2,
      longitude: (longitudeMin + longitudeMax) / 2,
    };
  }

  function parseCoordinateAngle(value) {
    const source = I.methods.trim(I.StringCtor(value || ""));
    if (!source) return null;
    const hemisphereMatches = I.methods.match(source, /[NSEW]/gi);
    if (hemisphereMatches && hemisphereMatches.length > 1) return null;
    const hemisphere = hemisphereMatches ? I.methods.toUpperCase(hemisphereMatches[0]) : "";
    const axis = I.methods.test(/[NS]/, hemisphere) ? "latitude" : I.methods.test(/[EW]/, hemisphere)
      ? "longitude" : null;
    const numbers = I.methods.match(I.methods.replace(source, /[NSEW]/gi, " "), /[+-]?\d+(?:\.\d+)?/g);
    if (!numbers || numbers.length < 1 || numbers.length > 3) return null;
    const degrees = I.NumberCtor(numbers[0]);
    const minutes = numbers.length > 1 ? I.NumberCtor(numbers[1]) : 0;
    const seconds = numbers.length > 2 ? I.NumberCtor(numbers[2]) : 0;
    if (!I.methods.every([degrees, minutes, seconds], I.Number.isFinite) ||
        minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    const magnitude = I.Math.abs(degrees) + minutes / 60 + seconds / 3600;
    const negative = hemisphere === "S" || hemisphere === "W" ||
      (!hemisphere && (degrees < 0 || I.Object.is(degrees, -0)));
    return { value: negative ? -magnitude : magnitude, axis };
  }

  function splitCoordinatePair(value) {
    const source = I.methods.trim(I.StringCtor(value || ""));
    const comma = I.methods.indexOf(source, ",");
    if (comma >= 0 && I.methods.indexOf(source, ",", comma + 1) < 0) {
      return [I.methods.slice(source, 0, comma), I.methods.slice(source, comma + 1)];
    }
    const hemispheres = I.Array.from(I.methods.matchAll(source, /[NSEW]/gi));
    if (hemispheres.length === 2) {
      const firstIndex = hemispheres[0].index || 0;
      if (I.methods.test(/\d/, I.methods.slice(source, 0, firstIndex))) {
        return [I.methods.slice(source, 0, firstIndex + 1), I.methods.slice(source, firstIndex + 1)];
      }
      const secondIndex = hemispheres[1].index || 0;
      return [I.methods.slice(source, 0, secondIndex), I.methods.slice(source, secondIndex)];
    }
    const parts = I.methods.filter(I.methods.split(source, /[\s/|;]+/), I.BooleanCtor);
    return parts.length === 2 ? parts : null;
  }

  function validCoordinatePair(latitude, longitude) {
    return I.Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      I.Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      ? { latitude, longitude }
      : null;
  }

  function parseCoordinateText(value) {
    const source = typeof value === "string" ? I.methods.trim(I.methods.replace(value, /\u2212/g, "-")) : "";
    if (!source) return null;

    const mapAt = I.methods.exec(/@([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)/, source);
    if (mapAt) return validCoordinatePair(I.NumberCtor(mapAt[1]), I.NumberCtor(mapAt[2]));
    if (I.methods.test(/^https?:\/\//i, source)) {
      try {
        const url = new URL(source);
        for (let _index5 = 0, _items5 = I.list(["q", "query", "ll", "center", "destination"]); _index5 < _items5.length; _index5++) {
          const name = _items5[_index5];
          const candidate = url.searchParams.get(name);
          const match = candidate && I.methods.exec(/^\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*$/, candidate);
          if (match) return validCoordinatePair(I.NumberCtor(match[1]), I.NumberCtor(match[2]));
        }
      } catch (_) {
        return null;
      }
    }

    const latitudeLabel = I.methods.exec(/lat(?:itude)?[^a-z\d+-]*([+-]?\d+(?:\.\d+)?)/i, source);
    const longitudeLabel = I.methods.exec(/(?:lon(?:gitude|g)?|lng)[^a-z\d+-]*([+-]?\d+(?:\.\d+)?)/i, source);
    if (latitudeLabel && longitudeLabel) {
      return validCoordinatePair(I.NumberCtor(latitudeLabel[1]), I.NumberCtor(longitudeLabel[1]));
    }

    const letters = I.methods.replace(source, /[^a-z]/gi, "");
    if (!letters || I.methods.test(/^[NSEW]+$/i, letters)) {
      const pair = splitCoordinatePair(source);
      if (pair) {
        const first = parseCoordinateAngle(pair[0]);
        const second = parseCoordinateAngle(pair[1]);
        if (first && second && (!first.axis || !second.axis || first.axis !== second.axis)) {
          let latitude;
          let longitude;
          if (first.axis === "longitude" || second.axis === "latitude") {
            latitude = second.value;
            longitude = first.value;
          } else {
            latitude = first.value;
            longitude = second.value;
          }
          const parsed = validCoordinatePair(latitude, longitude);
          if (parsed) return parsed;
        }
      }
    }
    return decodeGeohash(source);
  }

  function decimalPlaces(number) {
    const value = I.StringCtor(number);
    if (I.methods.includes(value, "e") || I.methods.includes(value, "E")) return 0;
    const dot = I.methods.indexOf(value, ".");
    return dot === -1 ? 0 : value.length - dot - 1;
  }

  function padCoordinate(raw) {
    if (decimalPlaces(raw) >= 7) return raw;
    return I.Math.round((raw + (randomUnit() - 0.5) * 1e-7) * 1e8) / 1e8;
  }

  function getPaddedCoordinates() {
    const reported = resolveReportedCoordinates(
      settings.latitude,
      settings.longitude,
      settings.approximateEnabled,
      settings.approximateRadius,
      settings.approximateSeed
    );
    if (
      paddedCoordinateCache &&
      paddedCoordinateCache.rawLatitude === reported.latitude &&
      paddedCoordinateCache.rawLongitude === reported.longitude
    ) {
      return paddedCoordinateCache;
    }
    paddedCoordinateCache = {
      rawLatitude: reported.latitude,
      rawLongitude: reported.longitude,
      latitude: padCoordinate(reported.latitude),
      longitude: padCoordinate(reported.longitude),
    };
    return paddedCoordinateCache;
  }

  function installGeolocationObjectModel(realm) {
    const Coordinates = realm.GeolocationCoordinates;
    const Position = realm.GeolocationPosition;
    if (Coordinates && Coordinates.prototype) {
      const keys = [
        "latitude",
        "longitude",
        "accuracy",
        "altitude",
        "altitudeAccuracy",
        "heading",
        "speed",
      ];
      for (let _index6 = 0, _items6 = I.list(keys); _index6 < _items6.length; _index6++) {
        const key = _items6[_index6];
        const descriptor = I.Object.getOwnPropertyDescriptor(Coordinates.prototype, key);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGetter = descriptor.get;
        installAccessor(Coordinates.prototype, key, {
          get: function geolocationCoordinateGetter() {
            const slots = I.WeakMapget(coordsSlots, this);
            if (slots) return slots[key];
            return I.nativeApply(nativeGetter, this, []);
          },
        });
      }
      const nativeToJSON = Coordinates.prototype.toJSON;
      installOverride(
        Coordinates.prototype,
        "toJSON",
        function geolocationCoordinatesToJSON() {
          const slots = I.WeakMapget(coordsSlots, this);
          if (slots) {
            return {
              accuracy: slots.accuracy,
              latitude: slots.latitude,
              longitude: slots.longitude,
              altitude: slots.altitude,
              altitudeAccuracy: slots.altitudeAccuracy,
              heading: slots.heading,
              speed: slots.speed,
            };
          }
          if (typeof nativeToJSON === "function") return I.nativeApply(nativeToJSON, this, []);
          return {};
        },
        0
      );
    }

    if (Position && Position.prototype) {
      for (let _index7 = 0, _items7 = I.list(["coords", "timestamp"]); _index7 < _items7.length; _index7++) {
        const key = _items7[_index7];
        const descriptor = I.Object.getOwnPropertyDescriptor(Position.prototype, key);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGetter = descriptor.get;
        installAccessor(Position.prototype, key, {
          get: function geolocationPositionGetter() {
            const slots = I.WeakMapget(positionSlots, this);
            if (slots) return slots[key];
            return I.nativeApply(nativeGetter, this, []);
          },
        });
      }
      const nativeToJSON = Position.prototype.toJSON;
      installOverride(
        Position.prototype,
        "toJSON",
        function geolocationPositionToJSON() {
          const slots = I.WeakMapget(positionSlots, this);
          if (slots) {
            const coords = I.WeakMapget(coordsSlots, slots.coords);
            return {
              timestamp: slots.timestamp,
              coords: coords
                ? {
                    accuracy: coords.accuracy,
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    altitude: coords.altitude,
                    altitudeAccuracy: coords.altitudeAccuracy,
                    heading: coords.heading,
                    speed: coords.speed,
                  }
                : slots.coords,
            };
          }
          if (typeof nativeToJSON === "function") return I.nativeApply(nativeToJSON, this, []);
          return {};
        },
        0
      );
    }
  }

  function createPosition(realm) {
    const padded = getPaddedCoordinates();
    const values = {
      latitude: padded.latitude,
      longitude: padded.longitude,
      accuracy: settings.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    };
    let coords;
    if (realm.GeolocationCoordinates && realm.GeolocationCoordinates.prototype) {
      coords = I.Object.create(realm.GeolocationCoordinates.prototype);
      I.WeakMapset(coordsSlots, coords, values);
    } else {
      coords = I.Object.freeze({ ...values });
    }
    const timestamp = I.dateNow();
    if (realm.GeolocationPosition && realm.GeolocationPosition.prototype) {
      const position = I.Object.create(realm.GeolocationPosition.prototype);
      I.WeakMapset(positionSlots, position, { coords, timestamp });
      return position;
    }
    return I.Object.freeze({ coords, timestamp });
  }

  function validGeoArguments(realm, receiver, success, error, options) {
    if (realm.Geolocation && !(receiver instanceof realm.Geolocation)) return false;
    if (typeof success !== "function") return false;
    if (error != null && typeof error !== "function") return false;
    if (options != null && I.ObjectCtor(options) !== options) return false;
    return true;
  }

  function reproduceNativeError(nativeMethod, receiver, args) {
    const forwarded = I.list(args);
    if (typeof forwarded[0] === "function") forwarded[0] = function noop() {};
    if (typeof forwarded[1] === "function") forwarded[1] = function noop() {};
    return I.nativeApply(nativeMethod, receiver, forwarded);
  }

  function deliver(callback, value, delay) {
    const bound = I.bind(callback, undefined, value);
    if (delay == null) I.queueMicrotask(bound);
    else I.setTimeout(bound, delay);
  }

  function buildGeolocationOverrides(realm, native) {
    const syntheticWatches = I.newMap();
    let nextWatchId = 1000000000 + I.Math.floor(randomUnit() * 100000000);
    let cached = null;

    function getCached(options) {
      const requestedAge = options == null ? undefined : options.maximumAge;
      const rawAge = requestedAge === undefined ? 0 : +requestedAge;
      const clampedAge = I.Number.isNaN(rawAge) ? 0 : I.Math.min(0xffffffff, I.Math.max(0, rawAge));
      const floorAge = I.Math.floor(clampedAge);
      const maximumAge = clampedAge - floorAge === 0.5
        ? floorAge + (floorAge % 2) : I.Math.round(clampedAge);
      if (!cached || maximumAge <= 0) return null;
      return I.dateNow() - cached.createdAt <= maximumAge ? cached.position : null;
    }

    function freshPosition() {
      const position = createPosition(realm);
      cached = { position, createdAt: I.dateNow() };
      return position;
    }

    function emitSpoofed(success) {
      deliver(success, freshPosition(), 10 + randomUnit() * 40);
    }

    function getCurrentPosition(success, error, options) {
      if (!validGeoArguments(realm, this, success, error, options)) {
        return reproduceNativeError(native.getCurrentPosition, this, arguments);
      }
      if (!protectionActive()) {
        return I.nativeApply(native.getCurrentPosition, this, [success, error, options]);
      }
      const cachedPosition = getCached(options);
      if (cachedPosition) {
        deliver(success, cachedPosition);
        return undefined;
      }
      if (settings.preservePermissionPrompt) {
        return I.nativeApply(native.getCurrentPosition, this, [
          function nativePromptGranted() {
            deliver(success, freshPosition());
          },
          error,
          options,
        ]);
      }
      emitSpoofed(success);
      return undefined;
    }

    function watchPosition(success, error, options) {
      if (!validGeoArguments(realm, this, success, error, options)) {
        reproduceNativeError(native.watchPosition, this, arguments);
        return 0;
      }
      if (!protectionActive()) {
        return I.nativeApply(native.watchPosition, this, [success, error, options]);
      }
      if (settings.preservePermissionPrompt) {
        return I.nativeApply(native.watchPosition, this, [
          function nativeWatchGranted() {
            if (protectionActive()) deliver(success, freshPosition());
          },
          error,
          options,
        ]);
      }

      const watchId = nextWatchId++;
      const record = { active: true, timer: 0 };
      I.Mapset(syntheticWatches, watchId, record);

      const emit = () => {
        if (!record.active || !protectionActive()) return;
        try {
          success(freshPosition());
        } catch (callbackError) {
          if (typeof realm.reportError === "function") realm.reportError(callbackError);
          else I.setTimeout(() => { throw callbackError; }, 0);
        }
      };
      const schedule = () => {
        if (!record.active || !protectionActive()) return;
        record.timer = I.setTimeout(() => {
          emit();
          schedule();
        }, 1000 + randomUnit() * 1000);
      };
      record.timer = I.setTimeout(() => {
        emit();
        schedule();
      }, 10 + randomUnit() * 40);

      const stop = () => {
        record.active = false;
        I.clearTimeout(record.timer);
        I.Mapdelete(syntheticWatches, watchId);
      };
      record.stop = stop;
      I.Setadd(syntheticWatchStops, stop);
      return watchId;
    }

    function clearWatch(watchId) {
      if (!arguments.length || (realm.Geolocation && !(this instanceof realm.Geolocation))) {
        return reproduceNativeError(native.clearWatch, this, arguments);
      }
      const record = I.Mapget(syntheticWatches, I.NumberCtor(watchId));
      if (record) {
        record.stop();
        I.Setdelete(syntheticWatchStops, record.stop);
        return undefined;
      }
      return I.nativeApply(native.clearWatch, this, [watchId]);
    }

    return { getCurrentPosition, watchPosition, clearWatch };
  }

  function stopAllSyntheticWatches() {
    for (let _index8 = 0, _items8 = I.list(I.Array.from(syntheticWatchStops)); _index8 < _items8.length; _index8++) {
      const stop = _items8[_index8];
      try {
        stop();
      } catch (_) {
        // No-op.
      }
    }
    I.Setclear(syntheticWatchStops);
  }

  const permissionSlots = I.newWeakMap();

  // Fake statuses are real EventTargets with the PermissionStatus prototype and
  // no own properties; the prototype accessors read their values from slots.
  function createPermissionStatus(realm) {
    const target = new realm.EventTarget();
    if (realm.PermissionStatus) I.Object.setPrototypeOf(target, realm.PermissionStatus.prototype);
    const slots = { state: "granted", name: "geolocation", onchange: null, listener: null };
    slots.listener = function (event) {
      if (typeof slots.onchange === "function") I.nativeApply(slots.onchange, target, [event]);
    };
    I.WeakMapset(permissionSlots, target, slots);
    const prototype = realm.PermissionStatus && realm.PermissionStatus.prototype;
    for (let _index9 = 0, _items9 = I.list(["state", "name"]); _index9 < _items9.length; _index9++) {
      const key = _items9[_index9];
      if (!prototype || !I.Object.getOwnPropertyDescriptor(prototype, key)) {
        I.Object.defineProperty(target, key, { value: slots[key], enumerable: true });
      }
    }
    if (!prototype || !I.Object.getOwnPropertyDescriptor(prototype, "onchange")) {
      I.Object.defineProperty(target, "onchange", {
        get: () => slots.onchange,
        set: (value) => setPermissionOnchange(target, slots, value),
        enumerable: true,
        configurable: true,
      });
    }
    return target;
  }

  function setPermissionOnchange(target, slots, value) {
    const next = typeof value === "function" ? value : null;
    if (!slots.onchange && next) target.addEventListener("change", slots.listener);
    if (slots.onchange && !next) target.removeEventListener("change", slots.listener);
    slots.onchange = next;
  }

  function installPermissionStatusAccessors(realm) {
    const prototype = realm.PermissionStatus && realm.PermissionStatus.prototype;
    if (!prototype) return;
    for (let _index10 = 0, _items10 = I.list(["state", "name", "onchange"]); _index10 < _items10.length; _index10++) {
      const key = _items10[_index10];
      const descriptor = I.Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor || typeof descriptor.get !== "function") continue;
      const nativeGet = descriptor.get;
      const nativeSet = descriptor.set;
      const accessors = {
        get: function permissionStatusGetter() {
          const slots = I.WeakMapget(permissionSlots, this);
          return slots ? slots[key] : I.nativeApply(nativeGet, this, []);
        },
      };
      if (key === "onchange" && typeof nativeSet === "function") {
        accessors.set = function permissionStatusSetter(value) {
          const slots = I.WeakMapget(permissionSlots, this);
          if (!slots) return I.nativeApply(nativeSet, this, [value]);
          setPermissionOnchange(this, slots, value);
          return undefined;
        };
      }
      installAccessor(prototype, key, accessors);
    }
  }

  function installPermissions(realm, native) {
    if (!realm.Permissions || !realm.navigator.permissions || !native.permissionsQuery) return;
    installPermissionStatusAccessors(realm);
    function permissionsQuery(descriptor) {
      if (!(this instanceof realm.Permissions)) {
        return I.nativeApply(native.permissionsQuery, this, [descriptor]);
      }
      if (
        protectionActive() &&
        !settings.preservePermissionPrompt &&
        descriptor &&
        descriptor.name === "geolocation"
      ) {
        return I.promiseResolve(createPermissionStatus(realm));
      }
      return I.nativeApply(native.permissionsQuery, this, [descriptor]);
    }
    installOverride(realm.Permissions.prototype, "query", permissionsQuery, 1);
  }

  function isDefaultLocaleRequest(locales) {
    return locales === undefined || (I.Array.isArray(locales) && locales.length === 0);
  }

  function copyConstructorStatics(Native, Wrapped) {
    for (let _index11 = 0, _items11 = I.list(I.Reflect.ownKeys(Native)); _index11 < _items11.length; _index11++) {
      const key = _items11[_index11];
      if (key === "name" || key === "length" || key === "prototype") continue;
      try {
        I.Object.defineProperty(Wrapped, key, I.Object.getOwnPropertyDescriptor(Native, key));
      } catch (_) {
        // Some engines expose non-copyable implementation-specific properties.
      }
    }
  }

  function effectiveLocales(locales) {
    return protectionActive() && settings.localeEnabled && isDefaultLocaleRequest(locales)
      ? settings.languages
      : locales;
  }

  function installConstructorOverride(container, property, Native, buildArguments) {
    if (!container || typeof Native !== "function") return null;
    const descriptor = I.Object.getOwnPropertyDescriptor(container, property);
    let Wrapped = function (...args) {

      const finalArgs = buildArguments(args);
      if (!new.target) return I.nativeApply(Native, this, finalArgs);
      const target = new.target && new.target !== Wrapped ? new.target : Native;
      return I.nativeConstruct(Native, finalArgs, target);
    };
    Wrapped = I.guardConstructor(Wrapped);
    registerOverride(Wrapped, property);
    disguiseAsNative(Wrapped, property, Native.length);
    try {
      I.Object.setPrototypeOf(Wrapped, I.Object.getPrototypeOf(Native));
      copyConstructorStatics(Native, Wrapped);
      I.Object.defineProperty(Wrapped, "prototype", {
        value: Native.prototype,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      const constructorDescriptor = I.Object.getOwnPropertyDescriptor(Native.prototype, "constructor");
      I.Object.defineProperty(Native.prototype, "constructor", {
        value: Wrapped,
        writable: constructorDescriptor ? constructorDescriptor.writable : true,
        enumerable: constructorDescriptor ? constructorDescriptor.enumerable : false,
        configurable: constructorDescriptor ? constructorDescriptor.configurable : true,
      });
    } catch (_) {
      // The important behavior is the native instance returned by Reflect.construct.
    }
    I.Object.defineProperty(container, property, {
      value: Wrapped,
      configurable: descriptor ? descriptor.configurable : true,
      enumerable: descriptor ? descriptor.enumerable : false,
      writable: descriptor ? descriptor.writable : true,
    });
    return Wrapped;
  }

  function installNavigatorLocale(realm) {
    const NavigatorPrototype = realm.Navigator && realm.Navigator.prototype;
    if (!NavigatorPrototype) return;
    const languageDescriptor = I.Object.getOwnPropertyDescriptor(NavigatorPrototype, "language");
    if (languageDescriptor && typeof languageDescriptor.get === "function") {
      const nativeGetLanguage = languageDescriptor.get;
      installAccessor(NavigatorPrototype, "language", {
        get: function navigatorLanguageGetter() {
          const nativeValue = I.nativeApply(nativeGetLanguage, this, []);
          return protectionActive() && settings.localeEnabled ? settings.language : nativeValue;
        },
      });
    }
    const languagesDescriptor = I.Object.getOwnPropertyDescriptor(NavigatorPrototype, "languages");
    if (languagesDescriptor && typeof languagesDescriptor.get === "function") {
      const nativeGetLanguages = languagesDescriptor.get;
      let languagesSource;
      let spoofedLanguages;
      installAccessor(NavigatorPrototype, "languages", {
        get: function navigatorLanguagesGetter() {
          const nativeValue = I.nativeApply(nativeGetLanguages, this, []);
          if (!protectionActive() || !settings.localeEnabled) return nativeValue;
          // Settings reloads replace the array; keep the frozen copy (and its
          // identity) unless the languages actually changed.
          if (settings.languages !== languagesSource) {
            const next = settings.languages;
            const same = spoofedLanguages && spoofedLanguages.length === next.length &&
              I.methods.every(next, (language, index) => spoofedLanguages[index] === language);
            if (!same) spoofedLanguages = I.Object.freeze(I.list(next));
            languagesSource = next;
          }
          return spoofedLanguages;
        },
      });
    }
  }

  function installLocaleMethod(target, property, localeIndex, optionsIndex, injectTimezone, formatDefault) {
    if (!target || typeof target[property] !== "function") return;
    const nativeMethod = target[property];
    installOverride(
      target,
      property,
      function localeAwareMethod(...args) {
        // Locale objects/arrays may have observable getters on every call.
        // Explicit options (even undefined) retain the native/proxy path.
        const cacheable = args.length <= optionsIndex &&
          (args[localeIndex] === undefined || typeof args[localeIndex] === "string");
        if (protectionActive() && settings.localeEnabled && isDefaultLocaleRequest(args[localeIndex])) {
          args[localeIndex] = settings.languages;
        }
        if (injectTimezone && protectionActive() && settings.timezoneEnabled) {
          if (cacheable) {
            const result = formatDefault(this, property, args[localeIndex], settings.timezone, settings);
            if (result !== undefined) return result;
          }
          args[optionsIndex] = I.withTimezone(args[optionsIndex], settings.timezone);
        }
        return I.nativeApply(nativeMethod, this, args);
      },
      nativeMethod.length
    );
  }

  function installLocaleMethods(realm, NativeDateTimeFormat) {
    installLocaleMethod(realm.Number && realm.Number.prototype, "toLocaleString", 0, 1, false);
    installLocaleMethod(realm.BigInt && realm.BigInt.prototype, "toLocaleString", 0, 1, false);
    installLocaleMethod(realm.String && realm.String.prototype, "localeCompare", 1, 2, false);
    installLocaleMethod(realm.String && realm.String.prototype, "toLocaleUpperCase", 0, 1, false);
    installLocaleMethod(realm.String && realm.String.prototype, "toLocaleLowerCase", 0, 1, false);
    installLocaleMethod(realm.Array && realm.Array.prototype, "toLocaleString", 0, 1, false);
    const typedArrays = [
      "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
      "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array",
      "BigUint64Array",
    ];
    for (let _index12 = 0, _items12 = I.list(typedArrays); _index12 < _items12.length; _index12++) {
      const name = _items12[_index12];
      const Constructor = realm[name];
      if (Constructor && Constructor.prototype) {
        installLocaleMethod(Constructor.prototype, "toLocaleString", 0, 1, false);
      }
    }
    const formatDefault = I.createDefaultDateFormatter(NativeDateTimeFormat);
    installLocaleMethod(realm.Date && realm.Date.prototype, "toLocaleString", 0, 1, true, formatDefault);
    installLocaleMethod(realm.Date && realm.Date.prototype, "toLocaleDateString", 0, 1, true, formatDefault);
    installLocaleMethod(realm.Date && realm.Date.prototype, "toLocaleTimeString", 0, 1, true, formatDefault);
  }

  function installIntlOverrides(realm) {
    if (!realm.Intl) return;
    const names = [
      "Collator", "NumberFormat", "PluralRules", "RelativeTimeFormat",
      "ListFormat", "DisplayNames", "Segmenter", "DurationFormat",
    ];
    for (let _index13 = 0, _items13 = I.list(names); _index13 < _items13.length; _index13++) {
      const name = _items13[_index13];
      const Native = realm.Intl[name];
      if (typeof Native !== "function") continue;
      installConstructorOverride(realm.Intl, name, Native, (args) => {
        if (protectionActive() && settings.localeEnabled && isDefaultLocaleRequest(args[0])) {
          args[0] = settings.languages;
        }
        return args;
      });
    }

    const NativeDateTimeFormat = realm.Intl.DateTimeFormat;
    if (typeof NativeDateTimeFormat === "function") {
      installConstructorOverride(realm.Intl, "DateTimeFormat", NativeDateTimeFormat, (args) => {
        if (protectionActive() && settings.localeEnabled && isDefaultLocaleRequest(args[0])) {
          args[0] = settings.languages;
        }
        if (protectionActive() && settings.timezoneEnabled) {
          args[1] = I.withTimezone(args[1], settings.timezone);
        }
        return args;
      });
    }
  }

  // Self-contained: its source is also injected into Worker bootstraps, so it
  // must not reference anything outside its own parameters.
  function createZoneTools(NativeDate, NativeDateTimeFormat, getTimezone, I) {
    "use strict";
    const nativeGetTime = NativeDate.prototype.getTime;
    const nativeGetUTCMilliseconds = NativeDate.prototype.getUTCMilliseconds;
    const nativeLocal = {
      getFullYear: NativeDate.prototype.getFullYear,
      getMonth: NativeDate.prototype.getMonth,
      getDate: NativeDate.prototype.getDate,
      getHours: NativeDate.prototype.getHours,
      getMinutes: NativeDate.prototype.getMinutes,
      getSeconds: NativeDate.prototype.getSeconds,
      getMilliseconds: NativeDate.prototype.getMilliseconds,
    };
    // V8 derives DST names from an equivalent year outside this range.
    const MAX_EPOCH_MS = 2147483647000;
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let formatterZone;
    let partsFormatter;
    let zoneNameFormatter;
    let currentNames;

    function refreshFormatters() {
      const timezone = getTimezone();
      if (formatterZone === timezone) return;
      partsFormatter = new NativeDateTimeFormat("en-US-u-ca-gregory-nu-latn", {
        timeZone: timezone,
        era: "short",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      zoneNameFormatter = new NativeDateTimeFormat("en-US", {
        timeZone: timezone,
        timeZoneName: "long",
      });
      currentNames = null;
      formatterZone = timezone;
    }

    function epoch(value) {
      return I.nativeApply(nativeGetTime, value, []);
    }

    function parts(value) {
      const timestamp = epoch(value);
      if (!I.Number.isFinite(timestamp)) return null;
      refreshFormatters();
      const result = {};
      for (let _index14 = 0, _items14 = I.list(I.formatToParts(partsFormatter, value)); _index14 < _items14.length; _index14++) {
        const part = _items14[_index14];
        if (part.type !== "literal") result[part.type] = part.value;
      }
      return {
        year: result.era === "BC" ? 1 - I.NumberCtor(result.year) : I.NumberCtor(result.year),
        month: I.NumberCtor(result.month),
        day: I.NumberCtor(result.day),
        hour: I.NumberCtor(result.hour) % 24,
        minute: I.NumberCtor(result.minute),
        second: I.NumberCtor(result.second),
        millisecond: I.nativeApply(nativeGetUTCMilliseconds, value, []),
        weekday: I.methods.indexOf(weekdayNames, result.weekday),
      };
    }

    function wallEpoch(values) {
      const numbers = I.methods.map([
        values.year, values.month, values.day, values.hour,
        values.minute, values.second, values.millisecond,
      ], I.NumberCtor);
      if (I.methods.some(numbers, (value) => !I.Number.isFinite(value))) return NaN;
      const date = new NativeDate(0);
      I.methods.setUTCFullYear(date, numbers[0], numbers[1] - 1, numbers[2]);
      I.methods.setUTCHours(date, numbers[3], numbers[4], numbers[5], numbers[6]);
      return epoch(date);
    }

    function offsetAt(timestamp) {
      const value = parts(new NativeDate(timestamp));
      if (!value) return NaN;
      // Keep second-level historical offsets for wall-clock conversions.
      return (timestamp - wallEpoch(value)) / 60000;
    }

    function timezoneOffset(timestamp) {
      const offset = offsetAt(timestamp);
      return I.Number.isNaN(offset) ? NaN : I.Math.trunc(offset) || 0;
    }

    function wallToEpoch(values) {
      const wall = wallEpoch({
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour == null ? 0 : values.hour,
        minute: values.minute == null ? 0 : values.minute,
        second: values.second == null ? 0 : values.second,
        millisecond: values.millisecond == null ? 0 : values.millisecond,
      });
      if (!I.Number.isFinite(wall)) return NaN;

      const offsets = I.newSet();
      for (let _index15 = 0, _items15 = I.list([-370, -183, -2, -1, 0, 1, 2, 183, 370]); _index15 < _items15.length; _index15++) {
        const days = _items15[_index15];
        const offset = offsetAt(wall + days * 86400000);
        if (I.Number.isFinite(offset)) I.Setadd(offsets, offset);
      }
      let probe = wall;
      for (let index = 0; index < 4; index += 1) {
        const offset = offsetAt(probe);
        if (!I.Number.isFinite(offset)) break;
        I.Setadd(offsets, offset);
        probe = wall + offset * 60000;
      }

      const candidates = [];
      for (let _index16 = 0, _items16 = I.list(offsets); _index16 < _items16.length; _index16++) {
        const offset = _items16[_index16];
        const candidate = wall + offset * 60000;
        const local = parts(new NativeDate(candidate));
        if (!local) continue;
        I.methods.push(candidates, { candidate, difference: wallEpoch(local) - wall });
      }
      const exact = I.methods.sort(I.methods.filter(candidates, (item) => item.difference === 0), (left, right) => left.candidate - right.candidate);
      if (exact.length) return exact[0].candidate;

      const afterGap = I.methods.sort(I.methods.filter(candidates, (item) => item.difference > 0), (left, right) =>
          left.difference - right.difference || left.candidate - right.candidate);
      if (afterGap.length) return afterGap[0].candidate;
      const beforeGap = I.methods.sort(candidates, (left, right) =>
        right.difference - left.difference || left.candidate - right.candidate);
      return beforeGap.length ? beforeGap[0].candidate : NaN;
    }

    // MakeFullYear: ToIntegerOrInfinity(y) in 0..99 maps to 1900 + that integer.
    function makeYear(value) {
      const year = I.NumberCtor(value);
      if (I.Number.isNaN(year)) return NaN;
      const integer = I.Math.trunc(year) || 0;
      return integer >= 0 && integer <= 99 ? 1900 + integer : year;
    }

    function yearText(year) {
      return (year < 0 ? "-" : "") + I.methods.padStart(I.StringCtor(I.Math.abs(year)), 4, "0");
    }

    function offsetText(offset) {
      const sign = offset <= 0 ? "+" : "-";
      const absolute = I.Math.abs(I.Math.trunc(offset));
      return sign + I.methods.padStart(I.StringCtor(I.Math.floor(absolute / 60)), 2, "0") +
        I.methods.padStart(I.StringCtor(absolute % 60), 2, "0");
    }

    function nameAt(timestamp) {
      refreshFormatters();
      const part = I.methods.find(I.formatToParts(zoneNameFormatter, new NativeDate(timestamp)), (item) => item.type === "timeZoneName");
      return part ? part.value : formatterZone;
    }

    function yearOffsets(timestamp) {
      const year = I.methods.getUTCFullYear(new NativeDate(timestamp));
      return [offsetAt(I.dateUTC(year, 0, 1)), offsetAt(I.dateUTC(year, 6, 1))];
    }

    // V8 shows the zone's current standard or daylight display name, and
    // decides DST outside 1970..2038 from an equivalent recent year.
    function equivalentTime(timestamp) {
      const date = new NativeDate(timestamp);
      const year = I.methods.getUTCFullYear(date);
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const january = new NativeDate(0);
      I.methods.setUTCFullYear(january, year, 0, 1);
      const recentYear = (leap ? 1956 : 1967) + (I.methods.getUTCDay(january) * 12) % 28;
      I.methods.setUTCFullYear(date, 2008 + (recentYear + 3 * 28 - 2008) % 28);
      return epoch(date);
    }

    function zoneName(value) {
      refreshFormatters();
      if (!currentNames) {
        const now = I.dateNow();
        const seasonalOffsets = yearOffsets(now);
        const january = seasonalOffsets[0], july = seasonalOffsets[1];
        const year = I.methods.getUTCFullYear(new NativeDate(now));
        const januaryTime = I.dateUTC(year, 0, 1);
        const julyTime = I.dateUTC(year, 6, 1);
        currentNames = january === july
          ? { standard: nameAt(januaryTime), daylight: null }
          : {
              standard: nameAt(january > july ? januaryTime : julyTime),
              daylight: nameAt(january > july ? julyTime : januaryTime),
            };
      }
      const timestamp = epoch(value);
      const probe = timestamp < 0 || timestamp > MAX_EPOCH_MS
        ? equivalentTime(timestamp)
        : timestamp;
      const daylight = offsetAt(probe) < I.nativeApply(I.Math.max, undefined, yearOffsets(probe));
      if (!daylight) return currentNames.standard;
      return currentNames.daylight || nameAt(timestamp);
    }

    function dateText(value) {
      const item = parts(value);
      if (!item) return "Invalid Date";
      return weekdayNames[item.weekday] + " " + monthNames[item.month - 1] + " " +
        I.methods.padStart(I.StringCtor(item.day), 2, "0") + " " + yearText(item.year);
    }

    function timeText(value) {
      const item = parts(value);
      if (!item) return "Invalid Date";
      return I.methods.padStart(I.StringCtor(item.hour), 2, "0") + ":" +
        I.methods.padStart(I.StringCtor(item.minute), 2, "0") + ":" +
        I.methods.padStart(I.StringCtor(item.second), 2, "0") + " GMT" +
        offsetText(offsetAt(epoch(value))) + " (" + zoneName(value) + ")";
    }

    function fullText(value) {
      return I.Number.isFinite(epoch(value))
        ? dateText(value) + " " + timeText(value)
        : "Invalid Date";
    }

    function isAmbiguous(value) {
      const source = I.methods.trim(I.StringCtor(value));
      if (I.methods.test(/^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/, source)) return false;
      return !(
        I.methods.test(/Z$/i, source) ||
        I.methods.test(/\b(?:UTC|GMT|[ECMP][SD]T)\b/i, source) ||
        I.methods.test(/[+-]\d{2}(?::?\d{2})?(?:\s*\([^)]*\))?$/, source)
      );
    }

    function localFields(date) {
      const read = (name) => I.nativeApply(nativeLocal[name], date, []);
      return {
        year: read("getFullYear"),
        month: read("getMonth") + 1,
        day: read("getDate"),
        hour: read("getHours"),
        minute: read("getMinutes"),
        second: read("getSeconds"),
        millisecond: read("getMilliseconds"),
      };
    }

    // Reinterprets a zone-less date string as wall time in the target zone.
    function parseLocal(value) {
      const source = I.StringCtor(value);
      const parsed = new NativeDate(source);
      if (!I.Number.isFinite(epoch(parsed)) || !isAmbiguous(source)) return epoch(parsed);
      let fields = localFields(parsed);
      // Parsing in the real zone shifts wall times that fall in its DST gap,
      // so prefer the same string read as UTC when that is equivalent.
      const marked = new NativeDate(
        I.methods.test(/^[+-]?\d{4,6}-\d{2}-\d{2}T/i, I.methods.trim(source)) ? I.methods.trim(source) + "Z" : source + " GMT"
      );
      if (I.Number.isFinite(epoch(marked)) &&
          I.Math.abs(epoch(marked) - wallEpoch(fields)) <= 86400000) {
        fields = {
          year: I.methods.getUTCFullYear(marked),
          month: I.methods.getUTCMonth(marked) + 1,
          day: I.methods.getUTCDate(marked),
          hour: I.methods.getUTCHours(marked),
          minute: I.methods.getUTCMinutes(marked),
          second: I.methods.getUTCSeconds(marked),
          millisecond: I.methods.getUTCMilliseconds(marked),
        };
      }
      return wallToEpoch(fields);
    }

    return {
      epoch, parts, offsetAt, timezoneOffset, wallEpoch, wallToEpoch, makeYear,
      yearText, dateText, timeText, fullText, isAmbiguous, parseLocal,
    };
  }

  function installDateSetterOverrides(prototype, NativeDate, tools) {
    const native = {
      setHours: prototype.setHours,
      setMinutes: prototype.setMinutes,
      setSeconds: prototype.setSeconds,
      setDate: prototype.setDate,
      setMonth: prototype.setMonth,
      setFullYear: prototype.setFullYear,
      setYear: prototype.setYear,
      setTime: prototype.setTime,
    };

    function active() {
      return protectionActive() && settings.timezoneEnabled;
    }

    function applyNative(method, receiver, args) {
      return I.nativeApply(native[method], receiver, I.list(args));
    }

    function currentParts(receiver, fullYearSpecial) {
      const timestamp = tools.epoch(receiver);
      if (I.Number.isFinite(timestamp)) return tools.parts(receiver);
      return fullYearSpecial
        ? { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }
        : null;
    }

    function commit(receiver, values) {
      const timestamp = tools.wallToEpoch(values);
      I.nativeApply(native.setTime, receiver, [timestamp]);
      return timestamp;
    }

    installOverride(prototype, "setHours", function setHours(hour, minute, second, ms) {
      if (!active()) return applyNative("setHours", this, arguments);
      try {
        const item = currentParts(this, false);
        if (!item) return NaN;
        return commit(this, {
          year: item.year, month: item.month, day: item.day,
          hour: I.NumberCtor(hour),
          minute: arguments.length >= 2 ? I.NumberCtor(minute) : item.minute,
          second: arguments.length >= 3 ? I.NumberCtor(second) : item.second,
          millisecond: arguments.length >= 4 ? I.NumberCtor(ms) : item.millisecond,
        });
      } catch (_) {
        return applyNative("setHours", this, arguments);
      }
    }, native.setHours.length);

    installOverride(prototype, "setMinutes", function setMinutes(minute, second, ms) {
      if (!active()) return applyNative("setMinutes", this, arguments);
      try {
        const item = currentParts(this, false);
        if (!item) return NaN;
        return commit(this, {
          year: item.year, month: item.month, day: item.day, hour: item.hour,
          minute: I.NumberCtor(minute),
          second: arguments.length >= 2 ? I.NumberCtor(second) : item.second,
          millisecond: arguments.length >= 3 ? I.NumberCtor(ms) : item.millisecond,
        });
      } catch (_) {
        return applyNative("setMinutes", this, arguments);
      }
    }, native.setMinutes.length);

    installOverride(prototype, "setSeconds", function setSeconds(second, ms) {
      if (!active()) return applyNative("setSeconds", this, arguments);
      try {
        const item = currentParts(this, false);
        if (!item) return NaN;
        return commit(this, {
          year: item.year, month: item.month, day: item.day, hour: item.hour,
          minute: item.minute, second: I.NumberCtor(second),
          millisecond: arguments.length >= 2 ? I.NumberCtor(ms) : item.millisecond,
        });
      } catch (_) {
        return applyNative("setSeconds", this, arguments);
      }
    }, native.setSeconds.length);

    installOverride(prototype, "setDate", function setDate(day) {
      if (!active()) return applyNative("setDate", this, arguments);
      try {
        const item = currentParts(this, false);
        if (!item) return NaN;
        return commit(this, {
          year: item.year, month: item.month, day: I.NumberCtor(day), hour: item.hour,
          minute: item.minute, second: item.second, millisecond: item.millisecond,
        });
      } catch (_) {
        return applyNative("setDate", this, arguments);
      }
    }, native.setDate.length);

    installOverride(prototype, "setMonth", function setMonth(month, day) {
      if (!active()) return applyNative("setMonth", this, arguments);
      try {
        const item = currentParts(this, false);
        if (!item) return NaN;
        return commit(this, {
          year: item.year,
          month: I.NumberCtor(month) + 1,
          day: arguments.length >= 2 ? I.NumberCtor(day) : item.day,
          hour: item.hour, minute: item.minute, second: item.second,
          millisecond: item.millisecond,
        });
      } catch (_) {
        return applyNative("setMonth", this, arguments);
      }
    }, native.setMonth.length);

    installOverride(prototype, "setFullYear", function setFullYear(year, month, day) {
      if (!active()) return applyNative("setFullYear", this, arguments);
      try {
        const item = currentParts(this, true);
        if (!item) return applyNative("setFullYear", this, arguments);
        return commit(this, {
          year: I.NumberCtor(year),
          month: arguments.length >= 2 ? I.NumberCtor(month) + 1 : item.month,
          day: arguments.length >= 3 ? I.NumberCtor(day) : item.day,
          hour: item.hour, minute: item.minute, second: item.second,
          millisecond: I.Number.isFinite(tools.epoch(this)) ? item.millisecond : 0,
        });
      } catch (_) {
        return applyNative("setFullYear", this, arguments);
      }
    }, native.setFullYear.length);

    if (typeof native.setYear === "function") {
      installOverride(prototype, "setYear", function setYear(year) {
        if (!active()) return applyNative("setYear", this, arguments);
        try {
          const numericYear = tools.makeYear(year);
          const item = currentParts(this, true);
          if (!item) return applyNative("setYear", this, arguments);
          return commit(this, {
            year: numericYear, month: item.month, day: item.day, hour: item.hour,
            minute: item.minute, second: item.second,
            millisecond: I.Number.isFinite(tools.epoch(this)) ? item.millisecond : 0,
          });
        } catch (_) {
          return applyNative("setYear", this, arguments);
        }
      }, native.setYear.length);
    }
  }

  function installXsltOverrides(realm, NativeDate, tools) {
    const Constructor = realm.XSLTProcessor;
    if (!Constructor || !Constructor.prototype) return;
    const pad = (value, length) => I.methods.padStart(I.StringCtor(value), length, "0");
    const rewrite = (value) => I.methods.replace(value, /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g, (match, fractional) => {
        const instant = new NativeDate(match);
        const timestamp = I.methods.getTime(instant);
        if (
          !protectionActive() ||
          !settings.timezoneEnabled ||
          !I.Number.isFinite(timestamp) ||
          I.Math.abs(timestamp - I.dateNow()) > 120000
        ) return match;
        const item = tools.parts(instant);
        if (!item) return match;
        const offset = tools.offsetAt(timestamp);
        const sign = offset <= 0 ? "+" : "-";
        const absolute = I.Math.abs(I.Math.trunc(offset));
        return pad(item.year, 4) + "-" + pad(item.month, 2) + "-" + pad(item.day, 2) +
          "T" + pad(item.hour, 2) + ":" + pad(item.minute, 2) + ":" +
          pad(item.second, 2) + (fractional || "") + sign +
          pad(I.Math.floor(absolute / 60), 2) + ":" + pad(absolute % 60, 2);
      });
    const rewriteTree = (node) => {
      if (!node) return;
      if (node.nodeType === 3 && typeof node.nodeValue === "string") {
        node.nodeValue = rewrite(node.nodeValue);
      }
      for (let _index17 = 0, _items17 = I.list(I.Array.from(node.childNodes || [])); _index17 < _items17.length; _index17++) {
        const child = _items17[_index17];
        rewriteTree(child);
      }
    };
    for (let _index18 = 0, _items18 = I.list(["transformToFragment", "transformToDocument"]); _index18 < _items18.length; _index18++) {
      const property = _items18[_index18];
      const nativeMethod = Constructor.prototype[property];
      if (typeof nativeMethod !== "function") continue;
      installOverride(Constructor.prototype, property, function xsltTransform() {
        const result = I.nativeApply(nativeMethod, this, I.list(arguments));
        try {
          rewriteTree(result);
        } catch (_) {
          // Preserve the native transform result on rewrite failure.
        }
        return result;
      }, nativeMethod.length);
    }
  }

  function installDocumentOverrides(realm, NativeDate, tools) {
    const DocumentPrototype = realm.Document && realm.Document.prototype;
    if (!DocumentPrototype) return;
    const descriptor = I.Object.getOwnPropertyDescriptor(DocumentPrototype, "lastModified");
    if (!descriptor || typeof descriptor.get !== "function") return;
    const nativeGet = descriptor.get;
    installAccessor(DocumentPrototype, "lastModified", {
      get: function documentLastModifiedGetter() {
        const nativeValue = I.nativeApply(nativeGet, this, []);
        if (!protectionActive() || !settings.timezoneEnabled) return nativeValue;
        const parsed = new NativeDate(nativeValue);
        const item = tools.parts(parsed);
        if (!item) return nativeValue;
        return I.methods.padStart(I.StringCtor(item.month), 2, "0") + "/" +
          I.methods.padStart(I.StringCtor(item.day), 2, "0") + "/" +
          tools.yearText(item.year) + " " +
          I.methods.padStart(I.StringCtor(item.hour), 2, "0") + ":" +
          I.methods.padStart(I.StringCtor(item.minute), 2, "0") + ":" +
          I.methods.padStart(I.StringCtor(item.second), 2, "0");
      },
    });
  }

  function installDateOverrides(realm, NativeDate, NativeDateTimeFormat) {
    if (!realm.Date || !NativeDate || !settings.timezone) return;
    const tools = createZoneTools(NativeDate, NativeDateTimeFormat, () => settings.timezone, I);
    const prototype = NativeDate.prototype;
    const nativeGetters = {
      getTime: prototype.getTime,
      getFullYear: prototype.getFullYear,
      getMonth: prototype.getMonth,
      getDate: prototype.getDate,
      getDay: prototype.getDay,
      getHours: prototype.getHours,
      getMinutes: prototype.getMinutes,
      getSeconds: prototype.getSeconds,
      getMilliseconds: prototype.getMilliseconds,
      getYear: prototype.getYear,
      getTimezoneOffset: prototype.getTimezoneOffset,
      toString: prototype.toString,
      toDateString: prototype.toDateString,
      toTimeString: prototype.toTimeString,
    };
    const partKeys = {
      getFullYear: "year",
      getMonth: "month",
      getDate: "day",
      getDay: "weekday",
      getHours: "hour",
      getMinutes: "minute",
      getSeconds: "second",
      getMilliseconds: "millisecond",
      getYear: "year",
    };
    for (let _index19 = 0, _items19 = I.list(I.Object.keys(partKeys)); _index19 < _items19.length; _index19++) {
      const property = _items19[_index19];
      installOverride(
        prototype,
        property,
        function timezoneDateGetter() {
          const nativeValue = I.nativeApply(nativeGetters[property], this, []);
          if (!protectionActive() || !settings.timezoneEnabled) return nativeValue;
          const item = tools.parts(this);
          if (!item) return NaN;
          const value = item[partKeys[property]];
          if (property === "getMonth") return value - 1;
          if (property === "getYear") return value - 1900;
          return value;
        },
        0
      );
    }
    installOverride(
      prototype,
      "getTimezoneOffset",
      function getTimezoneOffset() {
        const nativeValue = I.nativeApply(nativeGetters.getTimezoneOffset, this, []);
        if (!protectionActive() || !settings.timezoneEnabled) return nativeValue;
        return tools.timezoneOffset(tools.epoch(this));
      },
      0
    );
    installOverride(
      prototype,
      "toDateString",
      function toDateString() {
        const nativeValue = I.nativeApply(nativeGetters.toDateString, this, []);
        return protectionActive() && settings.timezoneEnabled ? tools.dateText(this) : nativeValue;
      },
      0
    );
    installOverride(
      prototype,
      "toTimeString",
      function toTimeString() {
        const nativeValue = I.nativeApply(nativeGetters.toTimeString, this, []);
        return protectionActive() && settings.timezoneEnabled ? tools.timeText(this) : nativeValue;
      },
      0
    );
    installOverride(
      prototype,
      "toString",
      function toString() {
        const nativeValue = I.nativeApply(nativeGetters.toString, this, []);
        return protectionActive() && settings.timezoneEnabled ? tools.fullText(this) : nativeValue;
      },
      0
    );

    installDateSetterOverrides(prototype, NativeDate, tools);
    installXsltOverrides(realm, NativeDate, tools);
    installDocumentOverrides(realm, NativeDate, tools);

    const nativeDateParse = I.dateParse;
    const globalDescriptor = I.Object.getOwnPropertyDescriptor(realm, "Date");
    let WrappedDate = function Date(...args) {

      if (!new.target) {
        if (!protectionActive() || !settings.timezoneEnabled) return NativeDate();
        return tools.fullText(new NativeDate());
      }
      if (!protectionActive() || !settings.timezoneEnabled) {
        const target = new.target === WrappedDate ? NativeDate : new.target;
        return I.nativeConstruct(NativeDate, args, target);
      }
      if (args.length === 1) {
        const target = new.target === WrappedDate ? NativeDate : new.target;
        if (typeof args[0] === "string" && tools.isAmbiguous(args[0])) {
          return I.nativeConstruct(NativeDate, [tools.parseLocal(args[0])], target);
        }
        return I.nativeConstruct(NativeDate, args, target);
      }
      if (args.length < 2) {
        const target = new.target === WrappedDate ? NativeDate : new.target;
        return I.nativeConstruct(NativeDate, args, target);
      }
      const timestamp = tools.wallToEpoch({
        year: tools.makeYear(args[0]),
        month: I.NumberCtor(args[1]) + 1,
        day: args.length > 2 ? I.NumberCtor(args[2]) : 1,
        hour: args.length > 3 ? I.NumberCtor(args[3]) : 0,
        minute: args.length > 4 ? I.NumberCtor(args[4]) : 0,
        second: args.length > 5 ? I.NumberCtor(args[5]) : 0,
        millisecond: args.length > 6 ? I.NumberCtor(args[6]) : 0,
      });
      const target = new.target === WrappedDate ? NativeDate : new.target;
      return I.nativeConstruct(NativeDate, [timestamp], target);
    };
    WrappedDate = I.guardConstructor(WrappedDate);
    registerOverride(WrappedDate, "Date");
    disguiseAsNative(WrappedDate, "Date", NativeDate.length);
    I.Object.setPrototypeOf(WrappedDate, I.Object.getPrototypeOf(NativeDate));
    copyConstructorStatics(NativeDate, WrappedDate);
    let wrappedParse = function parse(value) {
      if (!protectionActive() || !settings.timezoneEnabled) {
        return I.nativeApply(nativeDateParse, NativeDate, arguments);
      }
      const stringValue = typeof value === "string" ? value : "" + value;
      if (!tools.isAmbiguous(stringValue)) {
        return I.nativeApply(nativeDateParse, NativeDate, [stringValue]);
      }
      return tools.parseLocal(stringValue);
    };
    wrappedParse = I.guardMethod(wrappedParse);
    registerOverride(wrappedParse, "parse");
    disguiseAsNative(wrappedParse, "parse", nativeDateParse.length);
    I.Object.defineProperty(WrappedDate, "parse", {
      value: wrappedParse,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    I.Object.defineProperty(WrappedDate, "prototype", {
      value: NativeDate.prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const dateConstructorDescriptor =
      I.Object.getOwnPropertyDescriptor(NativeDate.prototype, "constructor");
    I.Object.defineProperty(NativeDate.prototype, "constructor", {
      value: WrappedDate,
      writable: dateConstructorDescriptor ? dateConstructorDescriptor.writable : true,
      enumerable: dateConstructorDescriptor ? dateConstructorDescriptor.enumerable : false,
      configurable: dateConstructorDescriptor ? dateConstructorDescriptor.configurable : true,
    });
    I.Object.defineProperty(realm, "Date", {
      value: WrappedDate,
      configurable: globalDescriptor ? globalDescriptor.configurable : true,
      enumerable: globalDescriptor ? globalDescriptor.enumerable : false,
      writable: globalDescriptor ? globalDescriptor.writable : true,
    });
  }

  // Shared by windows and worker payloads. Explicit zones, including invalid
  // arguments, are delegated unchanged; only an omitted/undefined zone defaults.
  function patchTemporalOverrides(realm, getTimezone, install, getLocales, I) {
    "use strict";
    const now = realm.Temporal && realm.Temporal.Now;
    if (!now) return;
    for (let _index20 = 0, _items20 = I.list([
      "timeZoneId", "plainDateTimeISO", "plainDateISO", "plainTimeISO", "zonedDateTimeISO",
    ]); _index20 < _items20.length; _index20++) {
      const property = _items20[_index20];
      const nativeMethod = now[property];
      if (typeof nativeMethod !== "function") continue;
      const method = {
        [property](...args) {
          const timezone = getTimezone();
          if (property === "timeZoneId" && timezone) return timezone;

          if (property !== "timeZoneId" && args[0] === undefined && timezone) args[0] = timezone;
          return I.nativeApply(nativeMethod, this, args);
        },
      }[property];
      install(now, property, method);
    }
    const prototype = realm.Temporal.Instant && realm.Temporal.Instant.prototype;
    const nativeLocaleString = prototype && prototype.toLocaleString;
    if (typeof nativeLocaleString !== "function") return;
    install(prototype, "toLocaleString", {
      toLocaleString(...args) {

        const locales = getLocales();
        if (locales && (args[0] === undefined || (I.Array.isArray(args[0]) && !args[0].length))) {
          args[0] = locales;
        }
        const timezone = getTimezone();
        if (timezone) args[1] = I.withTimezone(args[1], timezone);
        return I.nativeApply(nativeLocaleString, this, args);
      },
    }.toLocaleString);
  }

  function installEnvironmentOverrides(realm) {
    const NativeDate = realm.Date;
    const NativeDateTimeFormat = realm.Intl && realm.Intl.DateTimeFormat;
    installNavigatorLocale(realm);
    installDateOverrides(realm, NativeDate, NativeDateTimeFormat);
    installIntlOverrides(realm);
    installLocaleMethods(realm, NativeDateTimeFormat);
    patchTemporalOverrides(realm, () => protectionActive() && settings.timezoneEnabled
      ? settings.timezone : null, installOverride,
      () => protectionActive() && settings.localeEnabled ? settings.languages : null, I);
  }

  function patchWindow(realm) {
    if (!realm) return false;
    // Key by the realm's intrinsics: a WindowProxy survives navigation, while a
    // Window reused for a new document keeps its already patched globals.
    const realmKey = genuineFunctionPrototype(realm);
    if (!realmKey || I.WeakSethas(patchedRealms, realmKey)) return false;
    I.WeakSetadd(patchedRealms, realmKey);
    I.WeakSetadd(knownRealms, realmKey);
    // Another instance (inside that frame, or a re-injection) already owns it.
    if (realmMasked(realmKey)) return false;
    const previousErrorRealm = I.installErrorRealm;
    I.installErrorRealm = realm.Error;
    try {
      installFunctionMaskingOn(realm);
      installEnvironmentOverrides(realm);
      installWorkerPatching(realm);
      installIframeCoverage(realm);
      if (!realm.navigator || !realm.navigator.geolocation || !realm.Geolocation) {
        log("Patched locale/timezone-only realm");
        return true;
      }
      const geoPrototype = realm.Geolocation.prototype;
      const native = {
        getCurrentPosition: geoPrototype.getCurrentPosition,
        watchPosition: geoPrototype.watchPosition,
        clearWatch: geoPrototype.clearWatch,
        permissionsQuery:
          realm.Permissions && realm.Permissions.prototype
            ? realm.Permissions.prototype.query
            : null,
      };
      const apiRealm = {
        Geolocation: realm.Geolocation,
        GeolocationCoordinates: realm.GeolocationCoordinates,
        GeolocationPosition: realm.GeolocationPosition,
        Permissions: realm.Permissions,
        PermissionStatus: realm.PermissionStatus,
        EventTarget: realm.EventTarget,
        reportError: typeof realm.reportError === "function" ? I.bind(realm.reportError, realm) : null,
        navigator: realm.navigator,
      };
      installGeolocationObjectModel(apiRealm);
      const overrides = buildGeolocationOverrides(apiRealm, native);
      installOverride(geoPrototype, "getCurrentPosition", overrides.getCurrentPosition, 1);
      installOverride(geoPrototype, "watchPosition", overrides.watchPosition, 1);
      installOverride(geoPrototype, "clearWatch", overrides.clearWatch, 1);
      installPermissions(apiRealm, native);
      log("Patched realm", realm === window ? "top" : "iframe", {
        locale: settings.localeEnabled ? settings.language : "off",
        timezone: settings.timezoneEnabled ? settings.timezone : "off",
      });
      return true;
    } catch (error) {
      log("Could not patch realm", error);
      return false;
    } finally {
      I.installErrorRealm = previousErrorRealm;
    }
  }

  function tryPatchIframe(iframe, inserted = false) {
    if (!iframe || I.methods.toUpperCase(I.StringCtor(iframe.tagName)) !== "IFRAME") return;
    if (!iframe.isConnected || (!inserted && I.WeakSethas(watchedIframes, iframe))) return;
    try {
      patchWindow(iframe.contentWindow);
    } catch (_) {
      // Cross-origin frame: inaccessible by design.
    }
    if (I.WeakSethas(watchedIframes, iframe)) return;
    I.WeakSetadd(watchedIframes, iframe);
    iframe.addEventListener(
      "load",
      () => {
        try {
          patchWindow(iframe.contentWindow);
        } catch (_) {
          // Cross-origin frame.
        }
      },
      { once: false }
    );
  }

  function scanNodeForIframes(node) {
    if (!node || !I.methods.includes([1, 9, 11], node.nodeType)) return;
    if (I.methods.toUpperCase(I.StringCtor(node.tagName)) === "IFRAME") tryPatchIframe(node);
    if (node.firstChild && typeof node.querySelectorAll === "function") {
      for (let _index21 = 0, _items21 = I.list(node.querySelectorAll("iframe")); _index21 < _items21.length; _index21++) {
        const iframe = _items21[_index21];
        tryPatchIframe(iframe);
      }
    }
  }

  function installIframeCoverage(realm) {
    const realmKey = genuineFunctionPrototype(realm);
    if (!realmKey) return;
    // Keep each realm's observer intrinsics before page code can replace them.
    // Repeated installation must reuse these captures, including the async path.
    let observerApi = I.WeakMapget(iframeObserverApis, realmKey);
    if (!observerApi) {
      const Constructor = realm.MutationObserver;
      observerApi = {
        Constructor,
        observe: Constructor.prototype.observe,
        takeRecords: Constructor.prototype.takeRecords,
        disconnect: Constructor.prototype.disconnect,
        addedNodes: I.Object.getOwnPropertyDescriptor(realm.MutationRecord.prototype, "addedNodes").get,
      };
      I.WeakMapset(iframeObserverApis, realmKey, observerApi);
    }
    const doc = realm.document;
    if (!I.WeakSethas(coveredIframeRealms, realmKey)) {
      I.WeakSetadd(coveredIframeRealms, realmKey);
      if (realm.HTMLIFrameElement) {
        for (let _index22 = 0, _items22 = I.list(["contentWindow", "contentDocument"]); _index22 < _items22.length; _index22++) {
          const property = _items22[_index22];
          const target = realm.HTMLIFrameElement.prototype;
          const descriptor = I.Object.getOwnPropertyDescriptor(target, property);
          if (!descriptor || typeof descriptor.get !== "function") continue;
          installAccessor(target, property, {
            get: function iframeRealmGetter() {
              const value = I.nativeApply(descriptor.get, this, []);
              try {
                patchWindow(property === "contentWindow" ? value : value && value.defaultView);
              } catch (_) {}
              return value;
            },
          });
        }
      }

      // Node-taking APIs collect only their inserted subtrees, before native
      // insertion empties DocumentFragments. Text and empty elements are O(1).
      const nodePrototype = realm.Node.prototype;
      const nodeType = I.Object.getOwnPropertyDescriptor(nodePrototype, "nodeType").get;
      const firstChild = I.Object.getOwnPropertyDescriptor(nodePrototype, "firstChild").get;
      const parentNode = I.Object.getOwnPropertyDescriptor(nodePrototype, "parentNode").get;
      const queries = {
        1: realm.Element.prototype.querySelectorAll,
        9: realm.Document.prototype.querySelectorAll,
        11: realm.DocumentFragment.prototype.querySelectorAll,
      };
      const collect = (node, frames) => {
        if (!node || (typeof node !== "object" && typeof node !== "function")) return;
        let type;
        try { type = I.nativeApply(nodeType, node, []); } catch (_) { return; }
        if (!queries[type]) return;
        if (type === 1 && node.localName === "iframe") I.Setadd(frames, node);
        if (!I.nativeApply(firstChild, node, [])) return;
        for (let _index23 = 0, _items23 = I.list(I.nativeApply(queries[type], node, ["iframe"])); _index23 < _items23.length; _index23++) {
          const frame = _items23[_index23];
          I.Setadd(frames, frame);
        }
      };
      const patch = (frames) => {
        for (let _index24 = 0, _items24 = I.list(frames); _index24 < _items24.length; _index24++) {
          const frame = _items24[_index24];
          tryPatchIframe(frame, true);
        }
      };
      const wrapNodes = (prototype, property, argumentIndex) => {
        const descriptor = prototype && I.Object.getOwnPropertyDescriptor(prototype, property);
        if (!descriptor || typeof descriptor.value !== "function") return;
        installOverride(prototype, property, function domInsertion() {
          const frames = I.newSet();
          if (argumentIndex === undefined) {
            for (let index = 0; index < arguments.length; index++) collect(arguments[index], frames);
          } else collect(arguments[argumentIndex], frames);
          const result = I.nativeApply(descriptor.value, this, arguments);
          patch(frames);
          return result;
        });
      };
      // HTML setters, insertAdjacentHTML and document.write expose no inserted
      // nodes. A short-lived observer records just this operation's additions;
      // takeRecords is synchronous and never scans the destination's old DOM.
      const observeInsertion = (receiver, nativeMethod, args, useParent) => {
        const observer = I.nativeConstruct(observerApi.Constructor, [() => {}]);
        try {
          let target = receiver;
          if (useParent) target = I.nativeApply(parentNode, receiver, []) || receiver;
          I.nativeApply(observerApi.observe, observer, [target, { childList: true, subtree: true }]);
        } catch (_) { /* The native operation below owns receiver validation. */ }
        try {
          const result = I.nativeApply(nativeMethod, receiver, args);
          const frames = I.newSet();
          for (let _index25 = 0, _items25 = I.list(I.nativeApply(observerApi.takeRecords, observer, [])); _index25 < _items25.length; _index25++) {
            const record = _items25[_index25];
            for (let _index26 = 0, _items26 = I.list(I.nativeApply(observerApi.addedNodes, record, [])); _index26 < _items26.length; _index26++) {
              const node = _items26[_index26];
              collect(node, frames);
            }
          }
          patch(frames);
          return result;
        } finally { I.nativeApply(observerApi.disconnect, observer, []); }
      };
      const wrapHTML = (prototype, property, useParent) => {
        const descriptor = prototype && I.Object.getOwnPropertyDescriptor(prototype, property);
        if (!descriptor || typeof descriptor.value !== "function") return;
        installOverride(prototype, property, function htmlInsertion() {
          return observeInsertion(this, descriptor.value, arguments, useParent);
        });
      };
      for (let _index27 = 0, _items27 = I.list(["appendChild", "insertBefore", "replaceChild"]); _index27 < _items27.length; _index27++) {
        const property = _items27[_index27];
        wrapNodes(nodePrototype, property, 0);
      }
      for (let _index28 = 0, _items28 = I.list([realm.Element, realm.Document, realm.DocumentFragment,
        realm.CharacterData, realm.DocumentType]); _index28 < _items28.length; _index28++) {
        const constructor = _items28[_index28];
        for (let _index29 = 0, _items29 = I.list(["append", "prepend", "replaceChildren", "before", "after", "replaceWith"]); _index29 < _items29.length; _index29++) {
          const property = _items29[_index29];
          wrapNodes(constructor && constructor.prototype, property);
        }
      }
      wrapNodes(realm.Element.prototype, "insertAdjacentElement", 1);
      wrapHTML(realm.Element.prototype, "insertAdjacentHTML", true);
      for (let _index30 = 0, _items30 = I.list([realm.Element, realm.ShadowRoot]); _index30 < _items30.length; _index30++) {
        const constructor = _items30[_index30];
        const prototype = constructor && constructor.prototype;
        if (!prototype) continue;
        for (let _index31 = 0, _items31 = I.list(["innerHTML", "outerHTML"]); _index31 < _items31.length; _index31++) {
          const property = _items31[_index31];
          const descriptor = I.Object.getOwnPropertyDescriptor(prototype, property);
          if (!descriptor || typeof descriptor.set !== "function") continue;
          installAccessor(prototype, property, {
            set: function iframeHTMLSetter(value) {
              return observeInsertion(this, descriptor.set, [value], property === "outerHTML");
            },
          });
        }
      }
      for (let _index32 = 0, _items32 = I.list(["write", "writeln"]); _index32 < _items32.length; _index32++) {
        const property = _items32[_index32];
        wrapHTML(realm.Document.prototype, property, false);
      }
    }
    // Observe the Document itself, including document-start before <html> exists.
    if (doc && !I.WeakSethas(observedIframeDocuments, doc)) {
      I.WeakSetadd(observedIframeDocuments, doc);
      const observer = I.nativeConstruct(observerApi.Constructor, [(mutations) => {
        for (let _index33 = 0, _items33 = I.list(mutations); _index33 < _items33.length; _index33++) {
          const mutation = _items33[_index33];
          for (let _index34 = 0, _items34 = I.list(I.nativeApply(observerApi.addedNodes, mutation, [])); _index34 < _items34.length; _index34++) {
            const node = _items34[_index34];
            scanNodeForIframes(node);
          }
        }
      }]);
      I.nativeApply(observerApi.observe, observer, [doc, { childList: true, subtree: true }]);
      scanNodeForIframes(doc);
    }
  }

  function workerBootstrap(config, createZoneTools, patchTemporalOverrides, captureIntrinsics) {
    "use strict";
    const I = captureIntrinsics(self);
    const formatDefault = I.createDefaultDateFormatter(Intl.DateTimeFormat);
    const nativeToString = Function.prototype.toString;
    const nativeNames = I.newWeakMap();
    const mark = (fn, name, length) => {
      if (!I.hasOwn(fn, "prototype")) fn = I.guardMethod(fn);
      I.WeakMapset(nativeNames, fn, name);
      try {
        I.Object.defineProperty(fn, "name", { value: name, configurable: true });
        if (I.Number.isInteger(length)) {
          I.Object.defineProperty(fn, "length", { value: length, configurable: true });
        }
      } catch (_) {}
      return fn;
    };
    Function.prototype.toString = mark({
      toString() {
        const name = I.WeakMapget(nativeNames, this);
        return name ? "function " + name + "() { [native code] }" :
          I.nativeApply(nativeToString, this, []);
      },
    }.toString, "toString");

    patchTemporalOverrides(self, () => config.timezoneEnabled ? config.timezone : null,
      (target, property, method) => {
        const descriptor = I.Object.getOwnPropertyDescriptor(target, property);
        I.Object.defineProperty(target, property, {
          ...descriptor, value: mark(method, property, descriptor.value.length),
        });
      }, () => config.localeEnabled ? config.languages : null, I);

    const defaultLocales = (locales) =>
      locales === undefined || (I.Array.isArray(locales) && locales.length === 0);
    const languageList = I.Object.freeze(I.Array.from(config.languages));
    const NavigatorConstructor =
      typeof WorkerNavigator === "function" ? WorkerNavigator :
        (typeof Navigator === "function" ? Navigator : null);
    if (config.localeEnabled && NavigatorConstructor) {
      for (let _index35 = 0, _items35 = I.list(["language", "languages"]); _index35 < _items35.length; _index35++) {
        const property = _items35[_index35];
        const descriptor = I.Object.getOwnPropertyDescriptor(NavigatorConstructor.prototype, property);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGet = descriptor.get;
        const getter = mark(I.lookupGetter({
          get value() {
            const nativeValue = I.nativeApply(nativeGet, this, []);
            return property === "language" ? config.language : languageList;
          },
        }, "value"), "get " + property);
        I.Object.defineProperty(NavigatorConstructor.prototype, property, {
          get: getter,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
        });
      }
    }

    const wrapIntl = (name, injectTimezone) => {
      const Native = Intl[name];
      if (typeof Native !== "function") return;
      let Wrapped = function (...args) {

        if (config.localeEnabled && defaultLocales(args[0])) args[0] = config.languages;
        if (injectTimezone && config.timezoneEnabled) {
          args[1] = I.withTimezone(args[1], config.timezone);
        }
        const target = new.target && new.target !== Wrapped ? new.target : Native;
        if (!new.target) return I.nativeApply(Native, this, args);
        return I.nativeConstruct(Native, args, target);
      };
      Wrapped = I.guardConstructor(Wrapped);
      mark(Wrapped, name, Native.length);
      I.Object.setPrototypeOf(Wrapped, I.Object.getPrototypeOf(Native));
      for (let _index36 = 0, _items36 = I.list(I.Reflect.ownKeys(Native)); _index36 < _items36.length; _index36++) {
        const key = _items36[_index36];
        if (key === "name" || key === "length" || key === "prototype") continue;
        try {
          I.Object.defineProperty(Wrapped, key, I.Object.getOwnPropertyDescriptor(Native, key));
        } catch (_) {}
      }
      I.Object.defineProperty(Wrapped, "prototype", {
        value: Native.prototype,
        writable: false,
        configurable: false,
      });
      const constructorDescriptor = I.Object.getOwnPropertyDescriptor(Native.prototype, "constructor");
      I.Object.defineProperty(Native.prototype, "constructor", {
        value: Wrapped,
        writable: constructorDescriptor ? constructorDescriptor.writable : true,
        enumerable: constructorDescriptor ? constructorDescriptor.enumerable : false,
        configurable: constructorDescriptor ? constructorDescriptor.configurable : true,
      });
      Intl[name] = Wrapped;
    };
    for (let _index37 = 0, _items37 = I.list([
      "Collator", "NumberFormat", "PluralRules", "RelativeTimeFormat",
      "ListFormat", "DisplayNames", "Segmenter", "DurationFormat",
    ]); _index37 < _items37.length; _index37++) {
      const name = _items37[_index37];
      wrapIntl(name, false);
    }

    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const NativeDate = Date;
    const nativeDateMethods = {};
    for (let _index38 = 0, _items38 = I.list([
      "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes",
      "getSeconds", "getMilliseconds", "getYear", "getTimezoneOffset", "toString",
      "toDateString", "toTimeString", "setHours", "setMinutes", "setSeconds", "setDate",
      "setMonth", "setFullYear", "setYear", "setTime",
    ]); _index38 < _items38.length; _index38++) {
      const name = _items38[_index38];
      nativeDateMethods[name] = NativeDate.prototype[name];
    }
    const tools = config.timezoneEnabled
      ? createZoneTools(NativeDate, NativeDateTimeFormat, () => config.timezone, I)
      : null;
    wrapIntl("DateTimeFormat", true);

    const getters = {
      getFullYear: "year", getMonth: "month", getDate: "day", getDay: "weekday",
      getHours: "hour", getMinutes: "minute", getSeconds: "second",
      getMilliseconds: "millisecond", getYear: "year",
    };
    if (tools) {
      for (let _index39 = 0, _items39 = I.list(I.Object.keys(getters)); _index39 < _items39.length; _index39++) {
        const property = _items39[_index39];
        const nativeMethod = nativeDateMethods[property];
        const override = mark({
          [property]() {
            const nativeValue = I.nativeApply(nativeMethod, this, []);
            const value = tools.parts(this);
            if (!value) return nativeValue;
            const result = value[getters[property]];
            if (property === "getMonth") return result - 1;
            if (property === "getYear") return result - 1900;
            return result;
          },
        }[property], property, nativeMethod.length);
        NativeDate.prototype[property] = override;
      }
      const nativeOffset = nativeDateMethods.getTimezoneOffset;
      NativeDate.prototype.getTimezoneOffset = mark({
        getTimezoneOffset() {
          I.nativeApply(nativeOffset, this, []);
          return tools.timezoneOffset(tools.epoch(this));
        },
      }.getTimezoneOffset, "getTimezoneOffset");

      const textMethods = {
        toString: tools.fullText,
        toDateString: tools.dateText,
        toTimeString: tools.timeText,
      };
      for (let _index40 = 0, _items40 = I.list(I.Object.keys(textMethods)); _index40 < _items40.length; _index40++) {
        const property = _items40[_index40];
        const nativeMethod = nativeDateMethods[property];
        NativeDate.prototype[property] = mark({
          [property]() {
            I.nativeApply(nativeMethod, this, []);
            return textMethods[property](this);
          },
        }[property], property, 0);
      }

      const applySetter = (property, receiver, args) => {
        const nativeMethod = nativeDateMethods[property];
        try {
          const timestamp = tools.epoch(receiver);
          const item = I.Number.isFinite(timestamp)
            ? tools.parts(receiver)
            : (property === "setFullYear" || property === "setYear"
              ? { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }
              : null);
          if (!item) return I.nativeApply(nativeMethod, receiver, args);
          const values = {
            year: item.year, month: item.month, day: item.day, hour: item.hour,
            minute: item.minute, second: item.second,
            millisecond: I.Number.isFinite(timestamp) ? item.millisecond : 0,
          };
          if (property === "setHours") {
            values.hour = I.NumberCtor(args[0]);
            if (args.length >= 2) values.minute = I.NumberCtor(args[1]);
            if (args.length >= 3) values.second = I.NumberCtor(args[2]);
            if (args.length >= 4) values.millisecond = I.NumberCtor(args[3]);
          } else if (property === "setMinutes") {
            values.minute = I.NumberCtor(args[0]);
            if (args.length >= 2) values.second = I.NumberCtor(args[1]);
            if (args.length >= 3) values.millisecond = I.NumberCtor(args[2]);
          } else if (property === "setSeconds") {
            values.second = I.NumberCtor(args[0]);
            if (args.length >= 2) values.millisecond = I.NumberCtor(args[1]);
          } else if (property === "setDate") {
            values.day = I.NumberCtor(args[0]);
          } else if (property === "setMonth") {
            values.month = I.NumberCtor(args[0]) + 1;
            if (args.length >= 2) values.day = I.NumberCtor(args[1]);
          } else if (property === "setFullYear") {
            values.year = I.NumberCtor(args[0]);
            if (args.length >= 2) values.month = I.NumberCtor(args[1]) + 1;
            if (args.length >= 3) values.day = I.NumberCtor(args[2]);
          } else if (property === "setYear") {
            values.year = tools.makeYear(args[0]);
          }
          const result = tools.wallToEpoch(values);
          I.nativeApply(nativeDateMethods.setTime, receiver, [result]);
          return result;
        } catch (_) {
          return I.nativeApply(nativeMethod, receiver, args);
        }
      };
      for (let _index41 = 0, _items41 = I.list([
        "setHours", "setMinutes", "setSeconds", "setDate", "setMonth",
        "setFullYear", "setYear",
      ]); _index41 < _items41.length; _index41++) {
        const property = _items41[_index41];
        if (typeof nativeDateMethods[property] !== "function") continue;
        NativeDate.prototype[property] = mark({
          [property]() {
            return applySetter(property, this, I.list(arguments));
          },
        }[property], property, nativeDateMethods[property].length);
      }

      let WrappedDate = function Date(...args) {

        if (!new.target) return tools.fullText(new NativeDate());
        const target = new.target === WrappedDate ? NativeDate : new.target;
        if (args.length === 1) {
          return typeof args[0] === "string" && tools.isAmbiguous(args[0])
            ? I.nativeConstruct(NativeDate, [tools.parseLocal(args[0])], target)
            : I.nativeConstruct(NativeDate, args, target);
        }
        if (args.length >= 2) {
          const timestamp = tools.wallToEpoch({
            year: tools.makeYear(args[0]),
            month: I.NumberCtor(args[1]) + 1,
            day: args.length > 2 ? I.NumberCtor(args[2]) : 1,
            hour: args.length > 3 ? I.NumberCtor(args[3]) : 0,
            minute: args.length > 4 ? I.NumberCtor(args[4]) : 0,
            second: args.length > 5 ? I.NumberCtor(args[5]) : 0,
            millisecond: args.length > 6 ? I.NumberCtor(args[6]) : 0,
          });
          return I.nativeConstruct(NativeDate, [timestamp], target);
        }
        return I.nativeConstruct(NativeDate, args, target);
      };
      WrappedDate = I.guardConstructor(WrappedDate);
      mark(WrappedDate, "Date", NativeDate.length);
      I.Object.setPrototypeOf(WrappedDate, I.Object.getPrototypeOf(NativeDate));
      for (let _index42 = 0, _items42 = I.list(I.Reflect.ownKeys(NativeDate)); _index42 < _items42.length; _index42++) {
        const key = _items42[_index42];
        if (key === "name" || key === "length" || key === "prototype" || key === "parse") continue;
        try {
          I.Object.defineProperty(WrappedDate, key, I.Object.getOwnPropertyDescriptor(NativeDate, key));
        } catch (_) {}
      }
      I.Object.defineProperty(WrappedDate, "prototype", {
        value: NativeDate.prototype,
        writable: false,
        configurable: false,
      });
      const wrappedParse = mark({
        parse(value) {
          const source = typeof value === "string" ? value : "" + value;
          return tools.isAmbiguous(source) ? tools.parseLocal(source) : I.dateParse(source);
        },
      }.parse, "parse", I.dateParse.length);
      I.Object.defineProperty(WrappedDate, "parse", {
        value: wrappedParse,
        writable: true,
        configurable: true,
      });
      const dateConstructorDescriptor =
        I.Object.getOwnPropertyDescriptor(NativeDate.prototype, "constructor");
      I.Object.defineProperty(NativeDate.prototype, "constructor", {
        value: WrappedDate,
        writable: dateConstructorDescriptor ? dateConstructorDescriptor.writable : true,
        enumerable: dateConstructorDescriptor ? dateConstructorDescriptor.enumerable : false,
        configurable: dateConstructorDescriptor ? dateConstructorDescriptor.configurable : true,
      });
      self.Date = WrappedDate;
    }

    const localeMethod = (target, property, localeIndex, optionsIndex, withTimezone) => {
      if (!target || typeof target[property] !== "function") return;
      const nativeMethod = target[property];
      target[property] = mark({
        [property](...args) {
          const cacheable = args.length <= optionsIndex &&
            (args[localeIndex] === undefined || typeof args[localeIndex] === "string");
          if (config.localeEnabled && defaultLocales(args[localeIndex])) {
            args[localeIndex] = config.languages;
          }
          if (withTimezone && config.timezoneEnabled) {
            if (cacheable) {
              const result = formatDefault(this, property, args[localeIndex], config.timezone, config);
              if (result !== undefined) return result;
            }
            args[optionsIndex] = I.withTimezone(args[optionsIndex], config.timezone);
          }
          return I.nativeApply(nativeMethod, this, args);
        },
      }[property], property, nativeMethod.length);
    };
    localeMethod(I.Number.prototype, "toLocaleString", 0, 1, false);
    if (typeof BigInt === "function") localeMethod(BigInt.prototype, "toLocaleString", 0, 1, false);
    localeMethod(String.prototype, "localeCompare", 1, 2, false);
    localeMethod(String.prototype, "toLocaleUpperCase", 0, 1, false);
    localeMethod(String.prototype, "toLocaleLowerCase", 0, 1, false);
    localeMethod(Date.prototype, "toLocaleString", 0, 1, true);
    localeMethod(Date.prototype, "toLocaleDateString", 0, 1, true);
    localeMethod(Date.prototype, "toLocaleTimeString", 0, 1, true);

    if (config.baseUrl && typeof importScripts === "function") {
      const nativeImportScripts = importScripts;
      self.importScripts = mark({
        importScripts() {
          const urls = I.methods.map(arguments, (url) =>
            new URL(I.StringCtor(url), config.baseUrl).href);
          return I.nativeApply(nativeImportScripts, self, urls);
        },
      }.importScripts, "importScripts");
    }
  }

  function buildWorkerPayload(baseUrl) {
    const config = {
      localeEnabled: settings.localeEnabled,
      language: settings.language,
      languages: settings.languages,
      timezoneEnabled: settings.timezoneEnabled,
      timezone: settings.timezone,
      baseUrl: baseUrl || location.href,
    };
    return "(" + callOriginalToString(workerBootstrap) + ")(" + I.JSON.stringify(config) + ", " +
      callOriginalToString(createZoneTools) + ", " + callOriginalToString(patchTemporalOverrides) + ", " + callOriginalToString(captureIntrinsics) + ");";
  }

  function decodeDataWorker(url) {
    const match = I.methods.exec(/^data:([^,]*?),(.*)$/s, url);
    if (!match) return null;
    try {
      return I.methods.test(/;base64(?:;|$)/i, match[1])
        ? decodeURIComponent(escape(atob(match[2])))
        : decodeURIComponent(match[2]);
    } catch (_) {
      return null;
    }
  }

  function installWorkerPatching(realm) {
    if (!realm || (typeof realm.Worker !== "function" && typeof realm.SharedWorker !== "function")) return;
    const NativeBlob = realm.Blob;
    const NativeURL = realm.URL;
    if (!NativeBlob || !NativeURL || typeof NativeURL.createObjectURL !== "function") return;
    const nativeCreateObjectURL = NativeURL.createObjectURL;
    const nativeRevokeObjectURL = NativeURL.revokeObjectURL;

    installOverride(NativeURL, "createObjectURL", function createObjectURL(value) {
      const url = I.nativeApply(nativeCreateObjectURL, NativeURL, [value]);
      if (value instanceof NativeBlob) I.Mapset(trackedWorkerBlobs, url, value);
      return url;
    }, 1);
    installOverride(NativeURL, "revokeObjectURL", function revokeObjectURL(url) {
      const rawUrl = I.StringCtor(url);
      const result = I.nativeApply(nativeRevokeObjectURL, NativeURL, [rawUrl]);
      I.Mapdelete(trackedWorkerBlobs, rawUrl);
      const patched = I.Mapget(sharedWorkerUrls, rawUrl);
      if (patched) {
        I.nativeApply(nativeRevokeObjectURL, NativeURL, [patched]);
        I.Mapdelete(sharedWorkerUrls, rawUrl);
      }
      return result;
    }, 1);

    for (let _index43 = 0, _items43 = I.list(["Worker", "SharedWorker"]); _index43 < _items43.length; _index43++) {
      const property = _items43[_index43];
      const NativeWorker = realm[property];
      if (typeof NativeWorker !== "function") continue;
      const shared = property === "SharedWorker";
      let WrappedWorker = function (...originalArgs) {
        if (!new.target) return I.nativeApply(NativeWorker, this, arguments);
        const scriptURL = originalArgs[0];
        const options = originalArgs[1];
        const args = I.methods.slice(originalArgs);
        const target = new.target === WrappedWorker ? NativeWorker : new.target;
        const construct = () => I.nativeConstruct(NativeWorker, originalArgs, target);
        const constructPatched = () => {
          let optionGetterThrew = false;
          const patchedArgs = I.methods.slice(args);
          if (args[1] && (typeof args[1] === "object" || typeof args[1] === "function")) {
            patchedArgs[1] = new I.Proxy(args[1], { get(object, key) {
              try { return I.Reflect.get(object, key, object); }
              catch (error) { optionGetterThrew = true; throw error; }
            } });
          }
          try { return I.nativeConstruct(NativeWorker, patchedArgs, target); }
          catch (error) {
            // A generated Blob URL is a string, not the page's TrustedScriptURL.
            // Fall back only for the native TT sink rejection, not arbitrary
            // constructor/option errors. Never install a permissive TT policy.
            // Chromium may convert options before checking TT. A successful
            // getter read must not disable fallback; only a thrown getter does.
            // Retrying original arguments can read those getters a second time.
            if (!optionGetterThrew && realm.trustedTypes && error instanceof realm.TypeError &&
              I.methods.test(/TrustedScriptURL/, error.message)) return construct();
            throw error;
          }
        };
        if (!args.length || !protectionActive() || !settings.workerEnabled ||
          (!settings.localeEnabled && !settings.timezoneEnabled)) return construct();
        // Pass-through paths retain the original object and options untouched.
        if (!settings.patchUrlWorkers && typeof scriptURL !== "string") return construct();
        const rawUrl = I.StringCtor(scriptURL);
        if (!settings.patchUrlWorkers && !I.methods.startsWith(rawUrl, "blob:") && !I.methods.startsWith(rawUrl, "data:")) {
          return construct();
        }
        const cacheKey = new NativeURL(rawUrl, realm.location.href).href;
        if (shared && I.Maphas(sharedWorkerUrls, cacheKey)) {
          args[0] = I.Mapget(sharedWorkerUrls, cacheKey);
          return constructPatched();
        }
        let parts;
        if (I.methods.startsWith(rawUrl, "blob:")) {
          const blob = I.Mapget(trackedWorkerBlobs, rawUrl);
          if (!blob) return construct();
          parts = [buildWorkerPayload(realm.location.href), "\n", blob];
        } else if (I.methods.startsWith(rawUrl, "data:")) {
          const source = decodeDataWorker(rawUrl);
          if (source == null) return construct();
          parts = [buildWorkerPayload(realm.location.href), "\n", source];
        } else if (settings.patchUrlWorkers) {
          const absoluteUrl = cacheKey;
          // Cache the type read so a native dictionary conversion doesn't invoke
          // a page's getter twice. SharedWorker's string-name overload stays intact.
          const type = options && options.type;
          if (options && typeof options === "object") {
            args[1] = new I.Proxy(options, { get(object, key) {
              return key === "type" ? type : I.Reflect.get(object, key, object);
            } });
          }
          const payload = buildWorkerPayload(absoluteUrl);
          if (type === "module") {
            // Static dependencies execute in source order. A separate first
            // dependency installs the mask before the original module (and its
            // dependencies). Dynamic import can miss SharedWorker connect events.
            const prelude = I.nativeApply(nativeCreateObjectURL, NativeURL,
              [new NativeBlob([payload], { type: "text/javascript" })]);
            parts = ["import " + I.JSON.stringify(prelude) + ";\nimport " + I.JSON.stringify(absoluteUrl) + ";"];
          } else {
            parts = [payload, "\nimportScripts(" + I.JSON.stringify(absoluteUrl) + ");"];
          }
        } else return construct();

        // Reuse the wrapper URL: SharedWorker identity is (URL, name). A fresh
        // Blob URL per call would silently create separate workers or throw.
        const blob = new NativeBlob(parts, { type: "text/javascript" });
        const patched = I.nativeApply(nativeCreateObjectURL, NativeURL, [blob]);
        if (shared) I.Mapset(sharedWorkerUrls, cacheKey, patched);
        args[0] = patched;
        return constructPatched();
      };
      WrappedWorker = I.guardConstructor(WrappedWorker);
      registerOverride(WrappedWorker, property);
      disguiseAsNative(WrappedWorker, property, NativeWorker.length);
      I.Object.setPrototypeOf(WrappedWorker, I.Object.getPrototypeOf(NativeWorker));
      I.Object.defineProperty(WrappedWorker, "prototype", { value: NativeWorker.prototype,
        writable: false, enumerable: false, configurable: false });
      const constructorDescriptor = I.Object.getOwnPropertyDescriptor(NativeWorker.prototype, "constructor");
      I.Object.defineProperty(NativeWorker.prototype, "constructor", {
        ...constructorDescriptor, value: WrappedWorker,
      });
      const descriptor = I.Object.getOwnPropertyDescriptor(realm, property);
      I.Object.defineProperty(realm, property, { ...descriptor, value: WrappedWorker });
    }
  }

  function element(tag, properties) {
    const node = document.createElement(tag);
    if (properties) I.Object.assign(node, properties);
    return node;
  }

  function openSettingsPanel() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", openSettingsPanel, { once: true });
      return;
    }
    if (document.querySelector("[data-vlm-panel-host]")) return;
    const onboardingHost = document.querySelector("[data-vlm-onboarding-host]");
    if (onboardingHost) onboardingHost.remove();
    saveUiState({ ...readUiState(), onboardingSeen: true });

    const host = element("div");
    host.setAttribute("data-vlm-panel-host", VERSION);
    I.Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
    });
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 18px;
          background: rgba(2,6,23,.72); font: 15px/1.45 system-ui,sans-serif; color: #e5e7eb; }
        .card { box-sizing: border-box; width: min(100%, 460px); max-height: 92vh; overflow: auto;
          border: 1px solid #334155; border-radius: 16px; padding: 18px; background: #0f172a;
          box-shadow: 0 20px 60px rgba(0,0,0,.45); }
        h2 { margin: 0 0 5px; font-size: 20px; color: #fff; }
        .sub { margin: 0 0 16px; color: #94a3b8; font-size: 13px; }
        label { display: block; margin: 12px 0 5px; font-weight: 650; }
        .check { display: flex; align-items: center; gap: 9px; }
        input[type=checkbox] { width: 20px; height: 20px; }
        input[type=number], input[type=text], textarea, select { box-sizing: border-box; width: 100%; padding: 10px 11px; border: 1px solid #475569;
          border-radius: 9px; background: #020617; color: #fff; font: inherit; }
        textarea { min-height: 92px; resize: vertical; font: 12px/1.4 ui-monospace,monospace; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .section { margin-top: 17px; padding-top: 13px; border-top: 1px solid #334155; }
        .section h3 { margin: 0 0 8px; color: #fff; font-size: 16px; }
        .notice { margin: 14px 0; padding: 10px; border-radius: 9px; background: #172554;
          color: #bfdbfe; font-size: 13px; }
        .warning { margin: 7px 0 0; padding: 9px 10px; border: 1px solid #92400e; border-radius: 9px;
          background: #451a03; color: #fde68a; font-size: 12px; }
        .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
        .rule-actions { display: flex; justify-content: flex-start; margin-top: 8px; }
        .input-action { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: stretch; }
        .search-results { display: grid; gap: 7px; margin-top: 9px; }
        .search-result { width: 100%; text-align: left; font-weight: 500; }
        .muted { color: #94a3b8; font-size: 12px; }
        ul { margin: 8px 0 0; padding-left: 20px; }
        li + li { margin-top: 5px; }
        button { border: 1px solid #475569; border-radius: 9px; padding: 9px 13px; background: #1e293b;
          color: #fff; font: 650 14px system-ui,sans-serif; }
        button.primary { border-color: #2563eb; background: #2563eb; }
        #error { min-height: 20px; margin-top: 8px; color: #fca5a5; font-size: 13px; }
      </style>
      <div class="backdrop">
        <form class="card">
          <h2>Via Location Mask</h2>
          <p class="sub">v${VERSION} · 只影响网页，不改变 Android 系统 GPS 或 IP</p>
          <label class="check"><input id="enabled" type="checkbox">启用所有已勾选的伪装功能</label>
          <div id="currentStatus" class="notice"></div>
          <div class="section"><h3>网页定位</h3>
          <label for="citySearch">城市搜索</label>
          <div class="input-action">
            <input id="citySearch" type="text" autocomplete="off" placeholder="例如：Tokyo 或 台北">
            <button id="searchCity" type="button">搜索</button>
          </div>
          <div id="cityResults" class="search-results"></div>
          <div class="muted">仅点击搜索时请求 Open-Meteo；城市数据基于 GeoNames（CC BY 4.0）。免费接口仅限非商业使用。</div>
          <label for="coordinateText">快速输入坐标</label>
          <div class="input-action">
            <input id="coordinateText" type="text" autocomplete="off" placeholder="25.033, 121.5654 / DMS / Geohash / 地图链接">
            <button id="applyCoordinates" type="button">解析</button>
          </div>
          <div class="grid">
            <div><label for="latitude">纬度</label><input id="latitude" type="number" min="-90" max="90" step="any"></div>
            <div><label for="longitude">经度</label><input id="longitude" type="number" min="-180" max="180" step="any"></div>
          </div>
          <label for="accuracy">定位精度（米）</label>
          <input id="accuracy" type="number" min="1" max="100000" step="1">
          <label class="check"><input id="approximateEnabled" type="checkbox">使用稳定的近似位置</label>
          <label for="approximateRadius">最大偏移半径（米）</label>
          <input id="approximateRadius" type="number" min="50" max="50000" step="50">
          <div class="rule-actions"><button id="regenerateApproximate" type="button">重新生成偏移</button></div>
          <div id="precisionPreview" class="notice"></div>
           <div class="rule-actions"><button id="resolveTimezone" type="button">根据坐标解析时区</button></div>
           <label class="check"><input id="prompt" type="checkbox">保留网站原生定位权限提示</label>
           <div id="promptWarning" class="warning"><strong>通常请保持关闭。</strong>勾选后会真实调用 Via/Android 的网站定位授权流程；如果网站定位权限未授予、被拒绝或随后被撤销，定位请求可能返回 <code>GeolocationPositionError</code>。只需要伪装坐标时不要勾选。</div>
           </div>
          <div class="section"><h3>语言</h3>
            <label class="check"><input id="localeEnabled" type="checkbox">伪装 navigator 与 Intl 默认语言</label>
            <label for="language">主要语言标签</label>
            <input id="language" type="text" autocomplete="off" placeholder="zh-CN">
            <label for="languages">语言列表（逗号分隔）</label>
            <input id="languages" type="text" autocomplete="off" placeholder="zh-CN, en-US">
            <div class="notice">实验性：Via 无法同步修改 HTTP Accept-Language 请求头。默认关闭，以免脚本语言与请求头不一致。</div>
          </div>
          <div class="section"><h3>时区</h3>
            <label class="check"><input id="timezoneEnabled" type="checkbox">伪装 Date 与 Intl 默认时区</label>
            <label for="timezone">IANA 时区标识</label>
            <input id="timezone" type="text" autocomplete="off" placeholder="Asia/Taipei">
          </div>
          <div class="section"><h3>地点配置档</h3>
            <label for="profileSelect">已保存配置档</label>
            <select id="profileSelect"><option value="">请选择</option></select>
            <div class="actions">
              <button id="loadProfile" type="button">载入</button>
              <button id="deleteProfile" type="button">删除</button>
            </div>
            <label for="profileName">配置档名称</label>
            <input id="profileName" type="text" maxlength="40" placeholder="例如：东京">
            <button id="saveProfile" type="button">保存当前地点为配置档</button>
          </div>
          <div class="section"><h3>VPN 出口同步</h3>
            <button id="syncVpn" type="button">立即同步 VPN 出口</button>
            <label class="check"><input id="vpnAutoSync" type="checkbox">页面运行期间自动检查出口变化</label>
            <label for="vpnCheckMinutes">定时检查间隔（分钟，至少 5）</label>
            <input id="vpnCheckMinutes" type="number" min="5" max="1440" step="1">
            <div id="vpnStatus" class="notice"></div>
            <div class="muted">同步会向公网 IP 与 IP 地理位置服务发送网络请求；城市搜索和坐标时区解析会把查询词或坐标发送给对应服务。无浏览器后台任务，所有自动检查仅在至少一个网页运行时进行。</div>
          </div>
          <div class="section"><h3>网站范围</h3>
            <label for="siteMode">应用模式</label>
            <select id="siteMode">
              <option value="all">所有网站</option>
              <option value="allowlist">仅匹配列表的网站</option>
              <option value="denylist">除匹配列表外的网站</option>
            </select>
            <label for="sitePatterns">网站规则（每行一条）</label>
            <textarea id="sitePatterns" spellcheck="false" placeholder="example.com&#10;*.example.org&#10;https://site.com/maps/*"></textarea>
            <div class="rule-actions"><button id="addCurrentSite" type="button">添加当前网站</button></div>
            <div id="scopePreview" class="notice"></div>
          </div>
          <div class="section"><h3>Worker</h3>
            <label class="check"><input id="workerEnabled" type="checkbox">同步内联 Blob/Data Worker</label>
            <label class="check"><input id="patchUrlWorkers" type="checkbox">实验性同步 URL Worker</label>
            <div class="notice">URL Worker 增强可能被网站 CSP 拦截或改变 Worker 的 location；仅在测试确认网站兼容后启用。Service Worker 不会被改写。</div>
          </div>
          <div class="section"><h3>界面</h3>
            <label class="check"><input id="floatingButtonEnabled" type="checkbox">显示页面浮动入口</label>
            <div class="muted">默认关闭。启用后可从页面右下角打开设置；× 只隐藏当前标签页中的按钮。浮动入口会向页面 DOM 添加一个带封闭 Shadow DOM 的宿主元素。</div>
          </div>
          <div class="section"><h3>使用说明与限制</h3>
            <div class="notice">
              <strong>首次使用：</strong>先选择城市或填写坐标，再决定是否启用时区、实验性语言、Worker 和网站规则，最后开启总开关并保存。
              <ul>
                <li>仅修改网页 JavaScript 看到的值，不改变 Android GPS、系统语言或公网 IP。</li>
                <li>Via 无法改写 HTTP Accept-Language；语言伪装默认关闭。</li>
                <li>跨域 iframe 和 Service Worker 无法覆盖；URL Worker 仅为实验性尽力支持。</li>
                <li>VPN 自动同步只在至少一个网页标签运行时工作。</li>
                <li>Via 原生已禁用 WebRTC，本项目不实现 WebRTC 包装。</li>
              </ul>
            </div>
          </div>
          <div class="section"><h3>配置迁移</h3>
            <textarea id="configText" spellcheck="false" placeholder="配置 JSON"></textarea>
            <div class="actions"><button id="importConfig" type="button">从文本导入</button><button id="exportConfig" type="button">导出到文本框</button></div>
          </div>
          <label class="check"><input id="debug" type="checkbox">启用调试日志</label>
          <div class="notice">保留权限提示时，Via 会请求真实定位来触发系统授权流程，但真实坐标不会交给网页。默认关闭此选项。</div>
          <div id="error"></div>
          <div class="actions"><button id="cancel" type="button">取消</button><button class="primary" type="submit">保存并刷新</button></div>
        </form>
      </div>`;

    const byId = (id) => shadow.getElementById(id);
    let workingProfiles = [];
    let workingApproximateSeed = randomSeed();
    const renderProfiles = () => {
      const selected = byId("profileSelect").value;
      byId("profileSelect").replaceChildren(new Option("请选择", ""));
      I.methods.forEach(workingProfiles, (profile, index) => {
        byId("profileSelect").appendChild(new Option(profile.name, I.StringCtor(index)));
      });
      if (workingProfiles[I.NumberCtor(selected)]) byId("profileSelect").value = selected;
    };
    const updateScopePreview = () => {
      const mode = byId("siteMode").value;
      const patterns = I.methods.filter(I.methods.map(I.methods.split(byId("sitePatterns").value, /\r?\n/), (value) => I.methods.trim(value)), I.BooleanCtor);
      const invalid = I.methods.filter(patterns, (value) => !parseSitePattern(value));
      const matchedPatterns = I.methods.filter(patterns, (value) =>
        sitePatternMatches(value, location.href));
      const matched = matchedPatterns.length > 0;
      const active = byId("enabled").checked &&
        (mode === "all" || (mode === "allowlist" ? matched : !matched));
      let preview = "当前页面：" + (active ? "会启用伪装" : "不会启用伪装");
      if (mode === "all" && patterns.length) {
        preview += "；所有网站模式下，规则列表暂不参与判断";
      } else if (matchedPatterns.length) {
        preview += "；匹配规则：" + I.methods.join(matchedPatterns, "、");
      }
      preview += "；共 " + patterns.length + " 条规则";
      byId("scopePreview").textContent = invalid.length
        ? "无效规则：" + I.methods.join(invalid, "、")
        : preview;
      byId("scopePreview").style.color = invalid.length ? "#fca5a5" : "#bfdbfe";
      const features = ["定位"];
      if (byId("timezoneEnabled").checked) I.methods.push(features, "时区");
      if (byId("localeEnabled").checked) I.methods.push(features, "实验性语言");
      if (byId("workerEnabled").checked) I.methods.push(features, "Worker");
      byId("currentStatus").textContent = active
        ? "当前保护状态：已启用（" + I.methods.join(features, "、") + "）"
        : "当前保护状态：未启用；请检查总开关和网站范围。";
      byId("currentStatus").style.color = active ? "#86efac" : "#fbbf24";
    };
    const updatePrecisionPreview = () => {
      const enabled = byId("approximateEnabled").checked;
      const radius = I.NumberCtor(byId("approximateRadius").value);
      byId("approximateRadius").disabled = !enabled;
      byId("regenerateApproximate").disabled = !enabled;
      const latitude = I.NumberCtor(byId("latitude").value);
      const longitude = I.NumberCtor(byId("longitude").value);
      if (!I.Number.isFinite(latitude) || !I.Number.isFinite(longitude)) {
        byId("precisionPreview").textContent = "请先填写有效的纬度和经度。";
        return;
      }
      const reported = resolveReportedCoordinates(
        latitude,
        longitude,
        enabled,
        radius,
        workingApproximateSeed
      );
      byId("precisionPreview").textContent = enabled
        ? "网页将稳定收到：" + I.methods.toFixed(reported.latitude, 8) + ", " +
          I.methods.toFixed(reported.longitude, 8) + "（位于锚点半径内）"
        : "网页将收到所填锚点坐标；低位仍会做原生外观填充。";
    };
    const applyParsedCoordinates = (source) => {
      const parsed = parseCoordinateText(source);
      if (!parsed) {
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "无法识别坐标。请使用十进制、DMS、Geohash 或包含坐标的地图链接。";
        return false;
      }
      byId("latitude").value = I.StringCtor(I.NumberCtor(I.methods.toFixed(parsed.latitude, 8)));
      byId("longitude").value = I.StringCtor(I.NumberCtor(I.methods.toFixed(parsed.longitude, 8)));
      updatePrecisionPreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已解析坐标；保存并刷新后生效。";
      return true;
    };
    const updateVpnStatus = () => {
      const network = readNetworkState();
      const parts = [];
      if (network.lastSyncAt) {
        I.methods.push(parts, "上次同步：" + new Date(network.lastSyncAt).toLocaleString());
        if (network.lastSyncLabel) I.methods.push(parts, network.lastSyncLabel);
        if (network.lastIp) I.methods.push(parts, network.lastIp);
      } else {
        I.methods.push(parts, "尚未同步 VPN 出口");
      }
      if (network.lastError) I.methods.push(parts, "上次错误：" + network.lastError);
      byId("vpnStatus").textContent = I.methods.join(parts, "；");
      byId("vpnCheckMinutes").disabled = !byId("vpnAutoSync").checked;
    };
    const applyTimezoneForFormCoordinates = async (label) => {
      const latitude = I.NumberCtor(byId("latitude").value);
      const longitude = I.NumberCtor(byId("longitude").value);
      if (!validCoordinates(latitude, longitude)) {
        throw new Error("请先填写有效坐标。");
      }
      const resolved = await resolveTimezone(latitude, longitude);
      byId("timezone").value = resolved.timezone;
      byId("timezoneEnabled").checked = true;
      byId("error").style.color = "#86efac";
      byId("error").textContent = (label || "坐标") + "的时区已解析为 " +
        resolved.timezone + "（" + resolved.source + "）；保存并刷新后生效。";
      return resolved.timezone;
    };
    const renderCityResults = (results, cached) => {
      const container = byId("cityResults");
      container.replaceChildren();
      if (!results.length) {
        const empty = element("div", { className: "muted", textContent: "没有找到城市。" });
        container.appendChild(empty);
        return;
      }
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const button = element("button", {
          id: "cityResult" + index,
          type: "button",
          className: "search-result",
          textContent: result.name,
        });
        button.addEventListener("click", async () => {
          byId("latitude").value = I.StringCtor(result.latitude);
          byId("longitude").value = I.StringCtor(result.longitude);
          byId("coordinateText").value = result.latitude + ", " + result.longitude;
          byId("profileName").value = I.methods.join(I.methods.filter([result.city, result.country], I.BooleanCtor), ", ") ||
            I.methods.slice(result.name, 0, 40);
          updatePrecisionPreview();
          if (result.timezone) {
            byId("timezone").value = result.timezone;
            byId("timezoneEnabled").checked = true;
            byId("error").style.color = "#86efac";
            byId("error").textContent = "已选择城市并使用搜索结果中的时区 " +
              result.timezone + "；保存并刷新后生效。";
          } else {
            byId("error").style.color = "#bfdbfe";
            byId("error").textContent = "已选择城市，正在解析时区……";
            try {
              await applyTimezoneForFormCoordinates(result.city || "所选城市");
            } catch (error) {
              byId("error").style.color = "#fca5a5";
              byId("error").textContent = "城市坐标已填入，但时区解析失败：" +
                (error && error.message || error);
            }
          }
        });
        container.appendChild(button);
      }
      if (cached) container.prepend(element("div", {
        className: "muted",
        textContent: "以下结果来自本地缓存。",
      }));
    };
    const fillForm = (value) => {
      byId("enabled").checked = value.enabled;
      byId("latitude").value = I.StringCtor(value.latitude);
      byId("longitude").value = I.StringCtor(value.longitude);
      byId("accuracy").value = I.StringCtor(value.accuracy);
      byId("approximateEnabled").checked = value.approximateEnabled;
      byId("approximateRadius").value = I.StringCtor(value.approximateRadius);
      workingApproximateSeed = value.approximateSeed > 0
        ? value.approximateSeed
        : randomSeed();
      byId("prompt").checked = value.preservePermissionPrompt;
      byId("localeEnabled").checked = value.localeEnabled;
      byId("language").value = value.language;
      byId("languages").value = I.methods.join(value.languages, ", ");
      byId("timezoneEnabled").checked = value.timezoneEnabled;
      byId("timezone").value = value.timezone;
      byId("workerEnabled").checked = value.workerEnabled;
      byId("patchUrlWorkers").checked = value.patchUrlWorkers;
      byId("siteMode").value = value.siteMode;
      byId("sitePatterns").value = I.methods.join(value.sitePatterns, "\n");
      byId("vpnAutoSync").checked = value.vpnAutoSync;
      byId("vpnCheckMinutes").value = I.StringCtor(value.vpnCheckMinutes);
      byId("floatingButtonEnabled").checked = value.floatingButtonEnabled;
      workingProfiles = I.methods.map(value.profiles, (profile) => ({ ...profile }));
      renderProfiles();
      byId("debug").checked = value.debug;
      updatePrecisionPreview();
      updateScopePreview();
      updateVpnStatus();
    };
    fillForm(settings);

    const close = () => host.remove();
    byId("cancel").addEventListener("click", close);
    for (let _index44 = 0, _items44 = I.list([
      "enabled", "siteMode", "sitePatterns", "timezoneEnabled", "localeEnabled", "workerEnabled",
    ]); _index44 < _items44.length; _index44++) {
      const id = _items44[_index44];
      byId(id).addEventListener("input", updateScopePreview);
      byId(id).addEventListener("change", updateScopePreview);
    }
    for (let _index45 = 0, _items45 = I.list(["latitude", "longitude", "approximateEnabled", "approximateRadius"]); _index45 < _items45.length; _index45++) {
      const id = _items45[_index45];
      byId(id).addEventListener("input", updatePrecisionPreview);
      byId(id).addEventListener("change", updatePrecisionPreview);
    }
    byId("applyCoordinates").addEventListener("click", () => {
      applyParsedCoordinates(byId("coordinateText").value);
    });
    byId("searchCity").addEventListener("click", async () => {
      const button = byId("searchCity");
      button.disabled = true;
      byId("error").style.color = "#bfdbfe";
      byId("error").textContent = "正在搜索城市……";
      try {
        const response = await searchCities(byId("citySearch").value);
        renderCityResults(response.results, response.cached);
        byId("error").style.color = "#86efac";
        byId("error").textContent = "城市搜索完成；请选择结果。";
      } catch (error) {
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "城市搜索失败：" + (error && error.message || error);
      } finally {
        button.disabled = false;
      }
    });
    byId("citySearch").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        byId("searchCity").click();
      }
    });
    byId("resolveTimezone").addEventListener("click", async () => {
      const button = byId("resolveTimezone");
      button.disabled = true;
      byId("error").style.color = "#bfdbfe";
      byId("error").textContent = "正在解析坐标时区……";
      try {
        await applyTimezoneForFormCoordinates();
      } catch (error) {
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "时区解析失败：" + (error && error.message || error);
      } finally {
        button.disabled = false;
      }
    });
    byId("vpnAutoSync").addEventListener("change", updateVpnStatus);
    byId("syncVpn").addEventListener("click", async () => {
      const button = byId("syncVpn");
      button.disabled = true;
      byId("error").style.color = "#bfdbfe";
      byId("error").textContent = "正在查询公网 IP 与 VPN 出口位置……";
      try {
        const result = await getVpnLocation();
        applyVpnLocation(result);
        byId("error").style.color = "#86efac";
        byId("error").textContent = "已同步到 " +
          (I.methods.join(I.methods.filter([result.city, result.country], I.BooleanCtor), ", ") || result.ip) +
          "；即将刷新页面。";
        updateVpnStatus();
        I.setTimeout(() => location.reload(), 700);
      } catch (error) {
        const network = readNetworkState();
        network.lastError = I.methods.slice(I.StringCtor(error && error.message || error), 0, 500);
        saveNetworkState(network);
        updateVpnStatus();
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "VPN 同步失败：" + (error && error.message || error);
        button.disabled = false;
      }
    });
    byId("coordinateText").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyParsedCoordinates(byId("coordinateText").value);
      }
    });
    for (let _index46 = 0, _items46 = I.list(["latitude", "longitude"]); _index46 < _items46.length; _index46++) {
      const id = _items46[_index46];
      byId(id).addEventListener("paste", (event) => {
        const pasted = event.clipboardData && event.clipboardData.getData("text");
        if (pasted && applyParsedCoordinates(pasted)) event.preventDefault();
      });
    }
    byId("regenerateApproximate").addEventListener("click", () => {
      workingApproximateSeed = randomSeed();
      updatePrecisionPreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已重新生成近似位置；保存并刷新后生效。";
    });
    byId("addCurrentSite").addEventListener("click", () => {
      const rule = siteRuleForUrl(location.href);
      if (!rule) {
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "当前页面不是 HTTP/HTTPS 网站，无法生成网站规则。";
        return;
      }
      const patterns = I.methods.filter(I.methods.map(I.methods.split(byId("sitePatterns").value, /\r?\n/), (value) => I.methods.trim(value)), I.BooleanCtor);
      const exists = I.methods.some(patterns, (value) => I.methods.toLowerCase(value) === I.methods.toLowerCase(rule));
      if (!exists) {
        I.methods.push(patterns, rule);
        byId("sitePatterns").value = I.methods.join(patterns, "\n");
      }
      updateScopePreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = exists
        ? "当前网站规则已存在：" + rule
        : "已添加当前网站：" + rule + "。应用模式未改变，保存并刷新后生效。";
    });
    byId("loadProfile").addEventListener("click", () => {
      const profile = workingProfiles[I.NumberCtor(byId("profileSelect").value)];
      if (!profile) {
        byId("error").textContent = "请先选择配置档。";
        return;
      }
      byId("latitude").value = I.StringCtor(profile.latitude);
      byId("longitude").value = I.StringCtor(profile.longitude);
      byId("accuracy").value = I.StringCtor(profile.accuracy);
      byId("language").value = profile.language;
      byId("languages").value = I.methods.join(profile.languages, ", ");
      byId("timezone").value = profile.timezone;
      byId("profileName").value = profile.name;
      updatePrecisionPreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已载入“" + profile.name + "”，点击保存并刷新后生效。";
    });
    byId("saveProfile").addEventListener("click", () => {
      const name = I.methods.trim(byId("profileName").value);
      if (!name) {
        byId("error").textContent = "请填写配置档名称。";
        return;
      }
      const profile = normalizeProfile({
        name,
        latitude: byId("latitude").value,
        longitude: byId("longitude").value,
        accuracy: byId("accuracy").value,
        language: byId("language").value,
        languages: byId("languages").value,
        timezone: byId("timezone").value,
      }, workingProfiles.length);
      if (!profile) {
        byId("error").textContent = "当前地点资料无法保存。";
        return;
      }
      const existing = I.methods.findIndex(workingProfiles, (item) => item.name === profile.name);
      if (existing === -1) I.methods.push(workingProfiles, profile);
      else workingProfiles[existing] = profile;
      renderProfiles();
      byId("profileSelect").value = I.StringCtor(existing === -1 ? workingProfiles.length - 1 : existing);
      byId("error").style.color = "#86efac";
      byId("error").textContent = "配置档已加入表单，请点击保存并刷新以写入存储。";
    });
    byId("deleteProfile").addEventListener("click", () => {
      const index = I.NumberCtor(byId("profileSelect").value);
      if (!workingProfiles[index]) {
        byId("error").textContent = "请先选择配置档。";
        return;
      }
      const removed = I.methods.splice(workingProfiles, index, 1)[0];
      renderProfiles();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已从表单删除“" + removed.name + "”，保存并刷新后生效。";
    });
    byId("exportConfig").addEventListener("click", async () => {
      const exported = I.JSON.stringify({
        schema: 7,
        settings: { ...settings, profiles: workingProfiles },
      }, null, 2);
      byId("configText").value = exported;
      byId("configText").select();
      try {
        await navigator.clipboard.writeText(exported);
        byId("error").style.color = "#86efac";
        byId("error").textContent = "配置已写入文本框并复制到剪贴板。";
      } catch (_) {
        byId("error").style.color = "#bfdbfe";
        byId("error").textContent = "配置已写入文本框；长按即可复制。";
      }
    });
    byId("importConfig").addEventListener("click", () => {
      try {
        const parsed = I.JSON.parse(byId("configText").value);
        const imported = validateSettings(parsed && parsed.settings ? parsed.settings : parsed);
        fillForm(imported);
        byId("error").style.color = "#86efac";
        byId("error").textContent = "已载入表单，请检查后点击“保存并刷新”。";
      } catch (_) {
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "配置 JSON 无效。";
      }
    });
    shadow.querySelector(".backdrop").addEventListener("click", (event) => {
      if (event.target === shadow.querySelector(".backdrop")) close();
    });
    shadow.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const latitude = I.NumberCtor(byId("latitude").value);
      const longitude = I.NumberCtor(byId("longitude").value);
      const accuracy = I.NumberCtor(byId("accuracy").value);
      const approximateRadius = I.NumberCtor(byId("approximateRadius").value);
      const language = I.methods.trim(byId("language").value);
      const languages = I.methods.filter(I.methods.split(byId("languages").value, /[,，\s]+/), I.BooleanCtor);
      const timezone = I.methods.trim(byId("timezone").value);
      const siteMode = byId("siteMode").value;
      const sitePatterns = I.methods.filter(I.methods.map(I.methods.split(byId("sitePatterns").value, /\r?\n/), (value) => I.methods.trim(value)), I.BooleanCtor);
      if (!I.Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        byId("error").textContent = "纬度必须在 -90 到 90 之间。";
        return;
      }
      if (!I.Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        byId("error").textContent = "经度必须在 -180 到 180 之间。";
        return;
      }
      if (!I.Number.isFinite(accuracy) || accuracy < 1 || accuracy > 100000) {
        byId("error").textContent = "定位精度必须在 1 到 100000 米之间。";
        return;
      }
      if (!I.Number.isFinite(approximateRadius) ||
          approximateRadius < 50 || approximateRadius > 50000) {
        byId("error").textContent = "近似位置半径必须在 50 到 50000 米之间。";
        return;
      }
      try {
        if (!language || !Intl.getCanonicalLocales(language).length) throw new Error();
        Intl.getCanonicalLocales(languages);
      } catch (_) {
        byId("error").textContent = "语言标签无效，例如应填写 zh-CN、en-US。";
        return;
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch (_) {
        byId("error").textContent = "时区标识无效，例如应填写 Asia/Taipei。";
        return;
      }
      const invalidPatterns = I.methods.filter(sitePatterns, (value) => !parseSitePattern(value));
      if (invalidPatterns.length) {
        byId("error").textContent = "网站规则无效：" + I.methods.join(invalidPatterns, "、");
        return;
      }
      saveSettings({
        enabled: byId("enabled").checked,
        latitude,
        longitude,
        accuracy,
        approximateEnabled: byId("approximateEnabled").checked,
        approximateRadius,
        approximateSeed: workingApproximateSeed,
        preservePermissionPrompt: byId("prompt").checked,
        localeEnabled: byId("localeEnabled").checked,
        language,
        languages,
        timezoneEnabled: byId("timezoneEnabled").checked,
        timezone,
        workerEnabled: byId("workerEnabled").checked,
        patchUrlWorkers: byId("patchUrlWorkers").checked,
        siteMode,
        sitePatterns,
        profiles: workingProfiles,
        vpnAutoSync: byId("vpnAutoSync").checked,
        vpnCheckMinutes: I.NumberCtor(byId("vpnCheckMinutes").value),
        floatingButtonEnabled: byId("floatingButtonEnabled").checked,
        debug: byId("debug").checked,
      });
      close();
      location.reload();
    });
    document.body.appendChild(host);
  }

  function whenBodyAvailable(callback) {
    if (document.body) callback();
    else document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function installFloatingButton() {
    if (!settings.floatingButtonEnabled) return;
    whenBodyAvailable(() => {
      if (document.querySelector("[data-vlm-fab-host]")) return;
      const host = element("div");
      host.setAttribute("data-vlm-fab-host", VERSION);
      I.Object.assign(host.style, {
        all: "initial",
        position: "fixed",
        right: "max(14px, env(safe-area-inset-right))",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        zIndex: "2147483646",
      });
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .wrap { display: flex; align-items: stretch; border: 1px solid #64748b; border-radius: 999px;
            overflow: hidden; box-shadow: 0 5px 20px rgba(0,0,0,.35); background: #334155;
            font: 650 13px/1 system-ui,sans-serif; }
          .wrap.active { border-color: #22c55e; background: #14532d; }
          button { min-height: 42px; border: 0; color: #fff; background: transparent; font: inherit; }
          #vlmFabOpen { padding: 0 13px 0 15px; }
          #vlmFabClose { width: 38px; border-left: 1px solid rgba(255,255,255,.25); font-size: 17px; }
          button:active { background: rgba(255,255,255,.16); }
        </style>
        <div id="vlmFabWrap" class="wrap" role="group" aria-label="Via Location Mask">
          <button id="vlmFabOpen" type="button" aria-label="打开 Via Location Mask 设置"></button>
          <button id="vlmFabClose" type="button" aria-label="在当前页面隐藏浮动入口">×</button>
        </div>`;
      const refresh = () => {
        const active = protectionActive();
        shadow.getElementById("vlmFabWrap").classList.toggle("active", active);
        shadow.getElementById("vlmFabOpen").textContent = active ? "VLM 已保护" : "VLM 未保护";
      };
      refresh();
      const refreshTimer = setInterval(refresh, 1000);
      shadow.getElementById("vlmFabOpen").addEventListener("click", openSettingsPanel);
      shadow.getElementById("vlmFabClose").addEventListener("click", () => {
        clearInterval(refreshTimer);
        host.remove();
      });
      document.body.appendChild(host);
    });
  }

  function installOnboarding() {
    if (hasSavedSettings() || readUiState().onboardingSeen) return;
    whenBodyAvailable(() => {
      if (hasSavedSettings() || readUiState().onboardingSeen ||
          document.querySelector("[data-vlm-onboarding-host]")) return;
      const host = element("div");
      host.setAttribute("data-vlm-onboarding-host", VERSION);
      I.Object.assign(host.style, {
        all: "initial",
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
      });
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px;
            background: rgba(2,6,23,.70); font: 15px/1.5 system-ui,sans-serif; color: #e5e7eb; }
          .card { box-sizing: border-box; width: min(100%, 420px); padding: 19px; border: 1px solid #334155;
            border-radius: 16px; background: #0f172a; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
          h2 { margin: 0 0 7px; color: #fff; font-size: 20px; }
          p { margin: 8px 0; }
          ol { margin: 10px 0 0; padding-left: 22px; }
          .muted { color: #94a3b8; font-size: 12px; }
          .actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 17px; }
          button { border: 1px solid #475569; border-radius: 9px; padding: 10px 14px; background: #1e293b;
            color: #fff; font: 650 14px system-ui,sans-serif; }
          .primary { border-color: #2563eb; background: #2563eb; }
        </style>
        <div class="backdrop">
          <section class="card" role="dialog" aria-modal="true" aria-labelledby="vlmWelcomeTitle">
            <h2 id="vlmWelcomeTitle">欢迎使用 Via Location Mask</h2>
            <p>三步开始：</p>
            <ol><li>选择城市或填写坐标。</li><li>选择网站范围与需要的时区、语言和 Worker 功能。</li><li>打开总开关并保存刷新。</li></ol>
            <p class="muted">它只改变网页 JavaScript 看到的值，不改变 Android GPS 或公网 IP。语言、跨域 iframe、Service Worker 和后台自动同步存在 Via 限制。</p>
            <div class="actions"><button id="vlmOnboardingDismiss" type="button">稍后设置</button><button id="vlmOnboardingOpen" class="primary" type="button">打开设置</button></div>
          </section>
        </div>`;
      const finish = () => {
        saveUiState({ ...readUiState(), onboardingSeen: true });
        host.remove();
      };
      shadow.getElementById("vlmOnboardingDismiss").addEventListener("click", finish);
      shadow.getElementById("vlmOnboardingOpen").addEventListener("click", () => {
        finish();
        openSettingsPanel();
      });
      document.body.appendChild(host);
    });
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== "function") return;
    try {
      GM_registerMenuCommand("设置 Via Location Mask", openSettingsPanel);
      GM_registerMenuCommand(settings.enabled ? "关闭定位伪装" : "启用定位伪装", () => {
        saveSettings({ ...settings, enabled: !settings.enabled });
        location.reload();
      });
    } catch (error) {
      log("Could not register menu commands", error);
    }
  }

  discoverRealms();
  if (!realmPrePatched) {
    patchWindow(window);
  } else {
    // An ancestor's instance patched this realm, but wrappers this instance
    // installs below (iframe coverage) live in this registry: layer a mask
    // that names them and defers everything else to the ancestor's mask.
    I.WeakSetadd(patchedRealms, Function.prototype);
    installFunctionMaskingOn(window);
  }
  installIframeCoverage(window);
  registerMenus();
  installAutoVpnSync();
  installFloatingButton();
  installOnboarding();
  log("Installed", { version: VERSION, enabled: settings.enabled });
})();
