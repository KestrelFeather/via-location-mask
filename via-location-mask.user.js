// ==UserScript==
// @name         Via Location Mask
// @namespace    https://kestrelfeather.com/via-location-mask
// @version      1.0.1
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

  const VERSION = "1.0.1";
  const instanceKey = Symbol.for("via-location-mask.instance.v1");
  if (document[instanceKey]) return;
  Object.defineProperty(document, instanceKey, { value: true });

  // Independent userscript injections in same-origin frames share ownership
  // and function names. Documents (unlike WindowProxy) change on navigation.
  const sharedKey = Symbol.for("via-location-mask.realms.v1");
  let sharedDocument = document;
  try {
    let owner = window;
    while (owner.parent !== owner) {
      const parentDocument = owner.parent.document;
      owner = owner.parent;
      sharedDocument = parentDocument;
    }
  } catch (_) {
    // Stop at the first cross-origin boundary.
  }
  if (!sharedDocument[sharedKey]) {
    Object.defineProperty(sharedDocument, sharedKey, {
      value: { names: new WeakMap(), documents: new WeakSet() },
    });
  }
  const sharedRealms = sharedDocument[sharedKey];
  const STORAGE_KEY = "via-location-mask.settings.v1";
  const NETWORK_KEY = "via-location-mask.network.v1";
  const UI_STATE_KEY = "via-location-mask.ui.v1";
  const DEFAULT_SETTINGS = Object.freeze({
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

  const originals = {
    functionToString: Function.prototype.toString,
    functionCall: Function.prototype.call,
  };
  const overrideRegistry = sharedRealms.names;
  const patchedWindows = new WeakMap();
  const patchedWorkerRealms = new WeakSet();
  const maskedFunctionRealms = new WeakSet();
  const syntheticWatchStops = new Set();
  const coordsSlots = new WeakMap();
  const positionSlots = new WeakMap();
  let paddedCoordinateCache = null;
  let settings = readSettings();

  function log(...args) {
    if (settings.debug) console.debug("[Via Location Mask]", ...args);
  }

  function finiteNumber(value, fallback) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function randomSeed() {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      const seed = new Uint32Array(1);
      globalThis.crypto.getRandomValues(seed);
      return seed[0] || 1;
    }
    return Math.floor(Math.random() * 0xffffffff) + 1;
  }

  function canonicalLanguage(value, fallback) {
    try {
      return Intl.getCanonicalLocales(String(value || "").trim())[0] || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function canonicalTimezone(value, fallback) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: String(value || "").trim(),
      }).resolvedOptions().timeZone;
    } catch (_) {
      return fallback;
    }
  }

  function normalizeLanguageList(primary, input) {
    const raw = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? input.split(/[,\s]+/)
        : [];
    const result = [];
    for (const item of [primary, ...raw]) {
      const canonical = canonicalLanguage(item, "");
      if (canonical && !result.includes(canonical)) result.push(canonical);
    }
    return result.length ? result : [primary];
  }

  function normalizeProfile(input, index) {
    if (!input || typeof input !== "object") return null;
    const name = String(input.name || "配置档 " + (index + 1)).trim().slice(0, 40);
    if (!name) return null;
    const language = canonicalLanguage(input.language, DEFAULT_SETTINGS.language);
    return {
      name,
      latitude: Math.max(-90, Math.min(90, finiteNumber(input.latitude, DEFAULT_SETTINGS.latitude))),
      longitude: Math.max(
        -180,
        Math.min(180, finiteNumber(input.longitude, DEFAULT_SETTINGS.longitude))
      ),
      accuracy: Math.max(
        1,
        Math.min(100000, Math.round(finiteNumber(input.accuracy, DEFAULT_SETTINGS.accuracy)))
      ),
      language,
      languages: normalizeLanguageList(language, input.languages),
      timezone: canonicalTimezone(input.timezone, DEFAULT_SETTINGS.timezone),
    };
  }

  function escapePatternText(value) {
    return value.replace(/[.*+?^{}()|[\]\\$]/g, "\\$&");
  }

  function parseSitePattern(input) {
    const source = String(input || "").trim();
    if (!source || source.includes("?") || source.includes("#") || source.includes("\\")) {
      return null;
    }
    let rest = source;
    let scheme = null;
    const schemeMatch = /^(\*|https?):\/\//i.exec(rest);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase();
      rest = rest.slice(schemeMatch[0].length);
    } else if (rest.includes("://")) {
      return null;
    }
    const slash = rest.indexOf("/");
    let hostPort = slash === -1 ? rest : rest.slice(0, slash);
    let pathPattern = slash === -1 ? null : rest.slice(slash);
    if (pathPattern === "/") pathPattern = null;
    let port = null;
    const portMatch = /:(\*|\d+)$/.exec(hostPort);
    if (portMatch) {
      port = portMatch[1] === "*" ? null : portMatch[1];
      hostPort = hostPort.slice(0, -portMatch[0].length);
      if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
    }
    let host = hostPort.toLowerCase();
    const subdomainsOnly = host.startsWith("*.");
    if (subdomainsOnly) host = host.slice(2);
    const anyHost = host === "*";
    const ipv6 = host.startsWith("[") && host.endsWith("]");
    if (!host || (!anyHost && host.includes("*")) || (!ipv6 && host.includes(":"))) return null;
    if (ipv6 && subdomainsOnly) return null;
    let exactHostOnly = false;
    if (!anyHost) {
      try {
        const parsedHost = new URL("http://" + host);
        if (parsedHost.username || parsedHost.password || parsedHost.port) return null;
        host = parsedHost.hostname.toLowerCase();
      } catch (_) {
        return null;
      }
      const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
      exactHostOnly = ipv4 || ipv6 || !host.includes(".");
    }
    if (pathPattern && !pathPattern.startsWith("/")) return null;
    const pathRegex = pathPattern
      ? new RegExp("^" + pathPattern.split("*").map(escapePatternText).join(".*") + "$")
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
    const protocol = target.protocol.slice(0, -1).toLowerCase();
    if (!["http", "https"].includes(protocol)) return false;
    if (parsed.scheme && parsed.scheme !== "*" && parsed.scheme !== protocol) return false;
    const hostname = target.hostname.toLowerCase();
    const hostMatches = parsed.anyHost ||
      (parsed.subdomainsOnly
        ? hostname.endsWith("." + parsed.host)
        : hostname === parsed.host ||
          (!parsed.exactHostOnly && hostname.endsWith("." + parsed.host)));
    if (!hostMatches) return false;
    if (parsed.port !== null) {
      const effectivePort = target.port || (protocol === "https" ? "443" : "80");
      if (effectivePort !== parsed.port) return false;
    }
    return !parsed.pathRegex || parsed.pathRegex.test(target.pathname);
  }

  function siteRuleForUrl(url) {
    try {
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol)) return "";
      return target.hostname.toLowerCase() + (target.port ? ":" + target.port : "");
    } catch (_) {
      return "";
    }
  }

  function protectionActive() {
    if (!settings.enabled) return false;
    if (settings.siteMode === "all") return true;
    const matched = settings.sitePatterns.some((pattern) =>
      sitePatternMatches(pattern, location.href)
    );
    return settings.siteMode === "allowlist" ? matched : !matched;
  }

  function validateSettings(input) {
    const raw = input && typeof input === "object" ? input : {};
    const language = canonicalLanguage(raw.language, DEFAULT_SETTINGS.language);
    const rawLanguages = Array.isArray(raw.languages)
      ? raw.languages
      : typeof raw.languages === "string"
        ? raw.languages.split(/[,\s]+/)
        : DEFAULT_SETTINGS.languages;
    const languages = normalizeLanguageList(language, rawLanguages);
    const timezone = canonicalTimezone(raw.timezone, DEFAULT_SETTINGS.timezone);
    const siteMode = ["all", "allowlist", "denylist"].includes(raw.siteMode)
      ? raw.siteMode
      : "all";
    const sitePatterns = Array.isArray(raw.sitePatterns)
      ? Array.from(new Set(raw.sitePatterns.map((value) => String(value).trim())))
          .filter((value) => parseSitePattern(value))
          .slice(0, 200)
      : [];
    const profiles = [];
    const profileNames = new Set();
    if (Array.isArray(raw.profiles)) {
      for (let index = 0; index < raw.profiles.length && profiles.length < 30; index += 1) {
        const profile = normalizeProfile(raw.profiles[index], index);
        if (!profile || profileNames.has(profile.name)) continue;
        profileNames.add(profile.name);
        profiles.push(profile);
      }
    }
    return {
      enabled: raw.enabled === true,
      latitude: Math.max(
        -90,
        Math.min(90, finiteNumber(raw.latitude, DEFAULT_SETTINGS.latitude))
      ),
      longitude: Math.max(
        -180,
        Math.min(180, finiteNumber(raw.longitude, DEFAULT_SETTINGS.longitude))
      ),
      accuracy: Math.max(
        1,
        Math.min(100000, Math.round(finiteNumber(raw.accuracy, DEFAULT_SETTINGS.accuracy)))
      ),
      approximateEnabled: raw.approximateEnabled === true,
      approximateRadius: Math.max(
        50,
        Math.min(50000, Math.round(finiteNumber(raw.approximateRadius, 500)))
      ),
      approximateSeed:
        Number.isInteger(raw.approximateSeed) && raw.approximateSeed > 0
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
      vpnCheckMinutes: Math.max(
        5,
        Math.min(1440, Math.round(finiteNumber(raw.vpnCheckMinutes, 15)))
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
      if (typeof saved === "string") return validateSettings(JSON.parse(saved));
      return validateSettings(saved);
    } catch (error) {
      console.warn("[Via Location Mask] Could not read settings:", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(next) {
    const validated = validateSettings(next);
    if (typeof GM_setValue === "function") {
      GM_setValue(STORAGE_KEY, JSON.stringify(validated));
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
      const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
      return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveUiState(next) {
    if (typeof GM_setValue === "function") {
      GM_setValue(UI_STATE_KEY, JSON.stringify(next));
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
      const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
      return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveNetworkState(state) {
    if (typeof GM_setValue === "function") {
      GM_setValue(NETWORK_KEY, JSON.stringify(state));
    }
  }

  function trimCache(cache, maximumEntries) {
    const entries = Object.entries(cache || {}).sort((left, right) =>
      finiteNumber(right[1] && right[1].cachedAt, 0) -
      finiteNumber(left[1] && left[1].cachedAt, 0)
    );
    return Object.fromEntries(entries.slice(0, maximumEntries));
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function requestText(url, options = {}) {
    const timeout = finiteNumber(options.timeout, 8000);
    const headers = { Accept: options.accept || "application/json" };
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
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
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { headers, credentials: "omit", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .finally(() => clearTimeout(timer));
  }

  async function requestJson(url, options) {
    const text = await requestText(url, options);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error("服务返回了无效 JSON");
    }
  }

  function validCoordinates(latitude, longitude) {
    return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  }

  async function searchCities(query) {
    const normalized = String(query || "").trim();
    if (normalized.length < 3) throw new Error("请至少输入 3 个字符。");
    const cacheKey = "open-meteo:" + normalized.toLocaleLowerCase("en-US") + ":" +
      String(settings.language || "zh-CN").toLocaleLowerCase("en-US");
    let network = readNetworkState();
    const cached = network.cityCache && network.cityCache[cacheKey];
    if (cached && Date.now() - cached.cachedAt < 7 * 24 * 60 * 60 * 1000) {
      return { results: cached.results, cached: true };
    }
    const sinceLast = Date.now() - finiteNumber(network.geocoderAt, 0);
    if (sinceLast < 1100) await wait(1100 - sinceLast);
    network = readNetworkState();
    network.geocoderAt = Date.now();
    saveNetworkState(network);
    const parameters = new URLSearchParams({
      name: normalized,
      count: "10",
      language: String(settings.language || "zh-CN").split("-")[0].toLowerCase(),
      format: "json",
    });
    const data = await requestJson(
      "https://geocoding-api.open-meteo.com/v1/search?" + parameters,
      { timeout: 8000 }
    );
    if (!data || !Array.isArray(data.results)) {
      if (data && data.results == null) return { results: [], cached: false };
      throw new Error("城市搜索返回格式无效。");
    }
    const results = data.results.map((item) => {
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      const city = String(item.name || "");
      const country = String(item.country || item.country_code || "");
      const area = String(item.admin1 || "");
      const name = [city, area, country].filter((value, index, values) =>
        value && values.indexOf(value) === index
      ).join(", ");
      return {
        name: name || city || country,
        city,
        country,
        latitude,
        longitude,
        timezone: canonicalTimezone(item.timezone, ""),
      };
    }).filter((item) => validCoordinates(item.latitude, item.longitude))
      .slice(0, 5);
    network = readNetworkState();
    network.cityCache = trimCache({
      ...(network.cityCache || {}),
      [cacheKey]: { results, cachedAt: Date.now() },
    }, 40);
    saveNetworkState(network);
    return { results, cached: false };
  }

  async function resolveTimezone(latitude, longitude, hint) {
    const hinted = canonicalTimezone(hint, "");
    if (hinted) return { timezone: hinted, source: "IP 服务" };
    const key = Number(latitude).toFixed(4) + "," + Number(longitude).toFixed(4);
    let network = readNetworkState();
    const cached = network.timezoneCache && network.timezoneCache[key];
    if (cached && Date.now() - cached.cachedAt < 30 * 24 * 60 * 60 * 1000) {
      return { timezone: cached.timezone, source: "缓存" };
    }
    const parameters = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
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
      [key]: { timezone, cachedAt: Date.now() },
    }, 100);
    saveNetworkState(network);
    return { timezone, source: "TimeAPI.io" };
  }

  function isValidIpAddress(value) {
    const ip = String(value || "").trim();
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (ipv4) return ipv4.slice(1).every((part) => Number(part) <= 255);
    return /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i.test(ip);
  }

  const IP_PROVIDERS = [
    { name: "ipify", url: "https://api64.ipify.org/", parse: (body) => body.trim() },
    { name: "ident.me", url: "https://ident.me/", parse: (body) => body.trim() },
    { name: "ifconfig.me", url: "https://ifconfig.me/ip", parse: (body) => body.trim() },
    { name: "icanhazip", url: "https://icanhazip.com/", parse: (body) => body.trim() },
  ];

  async function detectPublicIp() {
    const failures = [];
    for (const provider of IP_PROVIDERS) {
      try {
        const body = await requestText(provider.url, { timeout: 8000 });
        const ip = provider.parse(body);
        if (!isValidIpAddress(ip)) throw new Error("无效 IP");
        return { ip, provider: provider.name };
      } catch (error) {
        failures.push(provider.name + ": " + (error && error.message || error));
      }
    }
    throw new Error("公网 IP 查询失败（" + failures.join("；") + "）");
  }

  function normalizeIpGeo(data) {
    if (!data || typeof data !== "object") return null;
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    const ip = String(data.ip || data.ipAddress || "").trim();
    if (!validCoordinates(latitude, longitude) || !isValidIpAddress(ip)) return null;
    const rawZones = Array.isArray(data.timeZones) && data.timeZones.length === 1
      ? data.timeZones[0]
      : data.timezone || data.time_zone || data.timeZone;
    return {
      latitude,
      longitude,
      ip,
      city: String(data.city || data.cityName || ""),
      country: String(data.country || data.countryName || data.country_name || data.countryCode || ""),
      timezone: canonicalTimezone(rawZones, ""),
    };
  }

  async function geolocateIp(ip) {
    let network = readNetworkState();
    const cached = network.ipGeoCache && network.ipGeoCache[ip];
    if (cached && Date.now() - cached.cachedAt < 30 * 24 * 60 * 60 * 1000) {
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
          const parts = String(data && data.loc || "").split(",");
          return normalizeIpGeo({
            ...data,
            latitude: Number(parts[0]),
            longitude: Number(parts[1]),
            country: data && data.country,
          });
        },
      },
    ];
    const failures = [];
    for (const service of services) {
      try {
        const data = await requestJson(service.url, { timeout: 7000 });
        const result = service.transform(data);
        if (!result) throw new Error("响应字段无效");
        if (result.ip !== ip && ip.includes(".")) throw new Error("响应 IP 不一致");
        network = readNetworkState();
        network.ipGeoCache = trimCache({
          ...(network.ipGeoCache || {}),
          [ip]: { result, cachedAt: Date.now() },
        }, 50);
        saveNetworkState(network);
        return { ...result, provider: service.name };
      } catch (error) {
        failures.push(service.name + ": " + (error && error.message || error));
      }
    }
    throw new Error("IP 地理位置解析失败（" + failures.join("；") + "）");
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
    network.lastIpCheckAt = Date.now();
    network.lastSyncAt = Date.now();
    network.lastSyncLabel = [result.city, result.country].filter(Boolean).join(", ") || result.ip;
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
    if (Date.now() - finiteNumber(network.lastIpCheckAt, 0) < 10000) return;
    autoSyncInFlight = (async () => {
      try {
        const first = await detectPublicIp();
        let state = readNetworkState();
        state.lastIpCheckAt = Date.now();
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
        state.lastError = String(error && error.message || error).slice(0, 500);
        state.lastIpCheckAt = Date.now();
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
    setTimeout(() => runAutoVpnCheck("page-open"), 1500);
    const interval = Math.max(5, settings.vpnCheckMinutes) * 60 * 1000;
    setInterval(() => runAutoVpnCheck("interval"), interval);
    addEventListener("online", () => runAutoVpnCheck("online"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") runAutoVpnCheck("foreground");
    });
    addEventListener("pageshow", () => runAutoVpnCheck("pageshow"));
  }

  function registerOverride(fn, nativeName) {
    overrideRegistry.set(fn, nativeName);
  }

  function callOriginalToString(fn) {
    return Reflect.apply(originals.functionToString, fn, []);
  }

  function isConstructible(fn) {
    if (typeof fn !== "function") return false;
    try {
      Reflect.construct(new Proxy(fn, { construct: () => ({}) }), []);
      return true;
    } catch (_) {
      return false;
    }
  }

  function stripConstruct(fn) {
    return {
      method() {
        const args = Array.prototype.slice.call(arguments);
        return Reflect.apply(fn, this, args);
      },
    }.method;
  }

  function disguiseAsNative(fn, nativeName, expectedLength) {
    Object.defineProperty(fn, "length", {
      value: expectedLength,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(fn, "name", {
      value: nativeName,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(fn, "prototype");
    if (prototypeDescriptor && prototypeDescriptor.configurable) delete fn.prototype;
  }

  function installOverride(target, property, implementation, forcedLength) {
    if (!target) return null;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    const original = descriptor && descriptor.value;
    const expectedLength =
      forcedLength == null && typeof original === "function"
        ? original.length
        : forcedLength == null
          ? 0
          : forcedLength;
    let finalFunction = implementation;
    if (
      Object.prototype.hasOwnProperty.call(implementation, "prototype") &&
      !isConstructible(original)
    ) {
      finalFunction = stripConstruct(implementation);
    }
    registerOverride(finalFunction, property);
    disguiseAsNative(finalFunction, property, expectedLength);
    Object.defineProperty(target, property, {
      value: finalFunction,
      configurable: descriptor ? descriptor.configurable : true,
      enumerable: descriptor ? descriptor.enumerable : false,
      writable: descriptor ? descriptor.writable : true,
    });
    return finalFunction;
  }

  function accessorMaskName(kind, property) {
    try {
      const nativeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
      return callOriginalToString(nativeGetter).includes("get size")
        ? `${kind} ${property}`
        : property;
    } catch (_) {
      return `${kind} ${property}`;
    }
  }

  function installAccessor(target, property, accessors) {
    const original = Object.getOwnPropertyDescriptor(target, property);
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
    Object.defineProperty(target, property, descriptor);
    return true;
  }

  function installFunctionMaskingOn(realm) {
    if (!realm || !realm.Function || maskedFunctionRealms.has(realm.Function.prototype)) return;
    const functionPrototype = realm.Function.prototype;
    const nativeToString = functionPrototype.toString;
    const numberSource = Reflect.apply(nativeToString, realm.Number, []);
    const split = numberSource.split("Number");
    const nativePrefix = split[0] || "function ";
    const nativeSuffix = split[1] || "() { [native code] }";
    const maskedToString = {
      toString() {
        const name = overrideRegistry.get(this);
        if (name !== undefined) return nativePrefix + name + nativeSuffix;
        return Reflect.apply(nativeToString, this, []);
      },
    }.toString;
    registerOverride(maskedToString, "toString");
    disguiseAsNative(maskedToString, "toString", 0);
    functionPrototype.toString = maskedToString;
    maskedFunctionRealms.add(functionPrototype);
  }

  function coordinateHash01(seed, latitude, longitude, salt) {
    const key = seed + "|" + salt + "|" + latitude + "|" + longitude;
    let hash = 1779033703 ^ key.length;
    for (let index = 0; index < key.length; index += 1) {
      hash = Math.imul(hash ^ key.charCodeAt(index), 3432918353);
      hash = (hash << 13) | (hash >>> 19);
    }
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    hash ^= hash >>> 16;
    let mixed = (hash + 0x6d2b79f5) | 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  function wrapLongitude(longitude) {
    if (longitude >= -180 && longitude < 180) return longitude;
    return (((longitude + 180) % 360) + 360) % 360 - 180;
  }

  function resolveReportedCoordinates(latitude, longitude, enabled, radius, seed) {
    const anchorLatitude = Math.max(-90, Math.min(90, finiteNumber(latitude, 0)));
    const anchorLongitude = wrapLongitude(finiteNumber(longitude, 0));
    if (!enabled) {
      return { latitude: anchorLatitude, longitude: anchorLongitude };
    }
    const safeRadius = Math.max(50, Math.min(50000, finiteNumber(radius, 500)));
    const distance = safeRadius * Math.sqrt(
      coordinateHash01(seed, anchorLatitude, anchorLongitude, 0x9e3779b9)
    );
    const bearing = 2 * Math.PI *
      coordinateHash01(seed, anchorLatitude, anchorLongitude, 0x85ebca6b);
    const earthRadius = 6371000;
    const north = distance * Math.cos(bearing);
    const east = distance * Math.sin(bearing);
    const latitudeOffset = north / earthRadius * 180 / Math.PI;
    const cosine = Math.cos(anchorLatitude * Math.PI / 180);
    const longitudeOffset = Math.abs(cosine) < 1e-12
      ? 0
      : east / (earthRadius * cosine) * 180 / Math.PI;
    return {
      latitude: Math.max(-90, Math.min(90, anchorLatitude + latitudeOffset)),
      longitude: wrapLongitude(anchorLongitude + longitudeOffset),
    };
  }

  const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

  function decodeGeohash(value) {
    const geohash = String(value || "").trim().toLowerCase();
    if (!/^[0123456789bcdefghjkmnpqrstuvwxyz]{5,12}$/.test(geohash) ||
        !/[b-z]/.test(geohash)) return null;
    let latitudeMin = -90;
    let latitudeMax = 90;
    let longitudeMin = -180;
    let longitudeMax = 180;
    let longitudeBit = true;
    for (const character of geohash) {
      const number = GEOHASH_ALPHABET.indexOf(character);
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
    const source = String(value || "").trim();
    if (!source) return null;
    const hemisphereMatches = source.match(/[NSEW]/gi);
    if (hemisphereMatches && hemisphereMatches.length > 1) return null;
    const hemisphere = hemisphereMatches ? hemisphereMatches[0].toUpperCase() : "";
    const axis = /[NS]/.test(hemisphere) ? "latitude" : /[EW]/.test(hemisphere)
      ? "longitude" : null;
    const numbers = source.replace(/[NSEW]/gi, " ").match(/[+-]?\d+(?:\.\d+)?/g);
    if (!numbers || numbers.length < 1 || numbers.length > 3) return null;
    const degrees = Number(numbers[0]);
    const minutes = numbers.length > 1 ? Number(numbers[1]) : 0;
    const seconds = numbers.length > 2 ? Number(numbers[2]) : 0;
    if (![degrees, minutes, seconds].every(Number.isFinite) ||
        minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600;
    const negative = hemisphere === "S" || hemisphere === "W" ||
      (!hemisphere && (degrees < 0 || Object.is(degrees, -0)));
    return { value: negative ? -magnitude : magnitude, axis };
  }

  function splitCoordinatePair(value) {
    const source = String(value || "").trim();
    const comma = source.indexOf(",");
    if (comma >= 0 && source.indexOf(",", comma + 1) < 0) {
      return [source.slice(0, comma), source.slice(comma + 1)];
    }
    const hemispheres = Array.from(source.matchAll(/[NSEW]/gi));
    if (hemispheres.length === 2) {
      const firstIndex = hemispheres[0].index || 0;
      if (/\d/.test(source.slice(0, firstIndex))) {
        return [source.slice(0, firstIndex + 1), source.slice(firstIndex + 1)];
      }
      const secondIndex = hemispheres[1].index || 0;
      return [source.slice(0, secondIndex), source.slice(secondIndex)];
    }
    const parts = source.split(/[\s/|;]+/).filter(Boolean);
    return parts.length === 2 ? parts : null;
  }

  function validCoordinatePair(latitude, longitude) {
    return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      ? { latitude, longitude }
      : null;
  }

  function parseCoordinateText(value) {
    const source = typeof value === "string" ? value.replace(/\u2212/g, "-").trim() : "";
    if (!source) return null;

    const mapAt = /@([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)/.exec(source);
    if (mapAt) return validCoordinatePair(Number(mapAt[1]), Number(mapAt[2]));
    if (/^https?:\/\//i.test(source)) {
      try {
        const url = new URL(source);
        for (const name of ["q", "query", "ll", "center", "destination"]) {
          const candidate = url.searchParams.get(name);
          const match = candidate && /^\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(candidate);
          if (match) return validCoordinatePair(Number(match[1]), Number(match[2]));
        }
      } catch (_) {
        return null;
      }
    }

    const latitudeLabel = /lat(?:itude)?[^a-z\d+-]*([+-]?\d+(?:\.\d+)?)/i.exec(source);
    const longitudeLabel = /(?:lon(?:gitude|g)?|lng)[^a-z\d+-]*([+-]?\d+(?:\.\d+)?)/i.exec(source);
    if (latitudeLabel && longitudeLabel) {
      return validCoordinatePair(Number(latitudeLabel[1]), Number(longitudeLabel[1]));
    }

    const letters = source.replace(/[^a-z]/gi, "");
    if (!letters || /^[NSEW]+$/i.test(letters)) {
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
    const value = String(number);
    if (value.includes("e") || value.includes("E")) return 0;
    const dot = value.indexOf(".");
    return dot === -1 ? 0 : value.length - dot - 1;
  }

  function padCoordinate(raw) {
    if (decimalPlaces(raw) >= 7) return raw;
    return Math.round((raw + (Math.random() - 0.5) * 1e-7) * 1e8) / 1e8;
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
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(Coordinates.prototype, key);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGetter = descriptor.get;
        installAccessor(Coordinates.prototype, key, {
          get: function geolocationCoordinateGetter() {
            const slots = coordsSlots.get(this);
            if (slots) return slots[key];
            return Reflect.apply(nativeGetter, this, []);
          },
        });
      }
      const nativeToJSON = Coordinates.prototype.toJSON;
      installOverride(
        Coordinates.prototype,
        "toJSON",
        function geolocationCoordinatesToJSON() {
          const slots = coordsSlots.get(this);
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
          if (typeof nativeToJSON === "function") return Reflect.apply(nativeToJSON, this, []);
          return {};
        },
        0
      );
    }

    if (Position && Position.prototype) {
      for (const key of ["coords", "timestamp"]) {
        const descriptor = Object.getOwnPropertyDescriptor(Position.prototype, key);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGetter = descriptor.get;
        installAccessor(Position.prototype, key, {
          get: function geolocationPositionGetter() {
            const slots = positionSlots.get(this);
            if (slots) return slots[key];
            return Reflect.apply(nativeGetter, this, []);
          },
        });
      }
      const nativeToJSON = Position.prototype.toJSON;
      installOverride(
        Position.prototype,
        "toJSON",
        function geolocationPositionToJSON() {
          const slots = positionSlots.get(this);
          if (slots) {
            const coords = coordsSlots.get(slots.coords);
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
          if (typeof nativeToJSON === "function") return Reflect.apply(nativeToJSON, this, []);
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
      coords = Object.create(realm.GeolocationCoordinates.prototype);
      coordsSlots.set(coords, values);
    } else {
      coords = Object.freeze({ ...values });
    }
    const timestamp = Date.now();
    if (realm.GeolocationPosition && realm.GeolocationPosition.prototype) {
      const position = Object.create(realm.GeolocationPosition.prototype);
      positionSlots.set(position, { coords, timestamp });
      return position;
    }
    return Object.freeze({ coords, timestamp });
  }

  function validGeoArguments(realm, receiver, success, error, options) {
    if (realm.Geolocation && !(receiver instanceof realm.Geolocation)) return false;
    if (typeof success !== "function") return false;
    if (error != null && typeof error !== "function") return false;
    if (options != null && Object(options) !== options) return false;
    return true;
  }

  function reproduceNativeError(nativeMethod, receiver, args) {
    const forwarded = Array.prototype.slice.call(args);
    if (typeof forwarded[0] === "function") forwarded[0] = function noop() {};
    if (typeof forwarded[1] === "function") forwarded[1] = function noop() {};
    return Reflect.apply(nativeMethod, receiver, forwarded);
  }

  function deliver(callback, value, delay) {
    const bound = callback.bind(undefined, value);
    if (delay == null) queueMicrotask(bound);
    else setTimeout(bound, delay);
  }

  function buildGeolocationOverrides(realm, native) {
    const syntheticWatches = new Map();
    let nextWatchId = 1000000000 + Math.floor(Math.random() * 100000000);
    let cached = null;

    function getCached(options) {
      const requestedAge = options == null ? undefined : options.maximumAge;
      const rawAge = requestedAge === undefined ? 0 : +requestedAge;
      const clampedAge = Number.isNaN(rawAge) ? 0 : Math.min(0xffffffff, Math.max(0, rawAge));
      const floorAge = Math.floor(clampedAge);
      const maximumAge = clampedAge - floorAge === 0.5
        ? floorAge + (floorAge % 2) : Math.round(clampedAge);
      if (!cached || maximumAge <= 0) return null;
      return Date.now() - cached.createdAt <= maximumAge ? cached.position : null;
    }

    function freshPosition() {
      const position = createPosition(realm);
      cached = { position, createdAt: Date.now() };
      return position;
    }

    function emitSpoofed(success) {
      deliver(success, freshPosition(), 10 + Math.random() * 40);
    }

    function getCurrentPosition(success, error, options) {
      if (!validGeoArguments(realm, this, success, error, options)) {
        return reproduceNativeError(native.getCurrentPosition, this, arguments);
      }
      if (!protectionActive()) {
        return Reflect.apply(native.getCurrentPosition, this, [success, error, options]);
      }
      const cachedPosition = getCached(options);
      if (cachedPosition) {
        deliver(success, cachedPosition);
        return undefined;
      }
      if (settings.preservePermissionPrompt) {
        return Reflect.apply(native.getCurrentPosition, this, [
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
        return Reflect.apply(native.watchPosition, this, [success, error, options]);
      }
      if (settings.preservePermissionPrompt) {
        return Reflect.apply(native.watchPosition, this, [
          function nativeWatchGranted() {
            if (protectionActive()) deliver(success, freshPosition());
          },
          error,
          options,
        ]);
      }

      const watchId = nextWatchId++;
      const record = { active: true, timer: 0 };
      syntheticWatches.set(watchId, record);

      const emit = () => {
        if (!record.active || !protectionActive()) return;
        try {
          success(freshPosition());
        } catch (callbackError) {
          if (typeof realm.reportError === "function") realm.reportError(callbackError);
          else setTimeout(() => { throw callbackError; }, 0);
        }
      };
      const schedule = () => {
        if (!record.active || !protectionActive()) return;
        record.timer = setTimeout(() => {
          emit();
          schedule();
        }, 1000 + Math.random() * 1000);
      };
      record.timer = setTimeout(() => {
        emit();
        schedule();
      }, 10 + Math.random() * 40);

      const stop = () => {
        record.active = false;
        clearTimeout(record.timer);
        syntheticWatches.delete(watchId);
      };
      record.stop = stop;
      syntheticWatchStops.add(stop);
      return watchId;
    }

    function clearWatch(watchId) {
      if (realm.Geolocation && !(this instanceof realm.Geolocation)) {
        return reproduceNativeError(native.clearWatch, this, arguments);
      }
      const record = syntheticWatches.get(Number(watchId));
      if (record) {
        record.stop();
        syntheticWatchStops.delete(record.stop);
        return undefined;
      }
      return Reflect.apply(native.clearWatch, this, [watchId]);
    }

    return { getCurrentPosition, watchPosition, clearWatch };
  }

  function stopAllSyntheticWatches() {
    for (const stop of Array.from(syntheticWatchStops)) {
      try {
        stop();
      } catch (_) {
        // No-op.
      }
    }
    syntheticWatchStops.clear();
  }

  function createPermissionStatus(realm) {
    const target = new realm.EventTarget();
    if (realm.PermissionStatus) Object.setPrototypeOf(target, realm.PermissionStatus.prototype);
    let onchange = null;
    const changeListener = function (event) {
      if (onchange) Reflect.apply(onchange, target, [event]);
    };
    Object.defineProperties(target, {
      state: {
        value: "granted",
        writable: false,
        enumerable: true,
        configurable: false,
      },
      name: {
        value: "geolocation",
        writable: false,
        enumerable: true,
        configurable: false,
      },
      onchange: {
        get: () => onchange,
        set: (value) => {
          const next = typeof value === "function" ? value : null;
          if (!onchange && next) target.addEventListener("change", changeListener);
          if (onchange && !next) target.removeEventListener("change", changeListener);
          onchange = next;
        },
        enumerable: true,
        configurable: true,
      },
    });
    return target;
  }

  function installPermissions(realm, native) {
    if (!realm.Permissions || !realm.navigator.permissions || !native.permissionsQuery) return;
    function permissionsQuery(descriptor) {
      if (!(this instanceof realm.Permissions)) {
        return Reflect.apply(native.permissionsQuery, this, [descriptor]);
      }
      if (
        protectionActive() &&
        !settings.preservePermissionPrompt &&
        descriptor &&
        descriptor.name === "geolocation"
      ) {
        return Promise.resolve(createPermissionStatus(realm));
      }
      return Reflect.apply(native.permissionsQuery, this, [descriptor]);
    }
    installOverride(realm.Permissions.prototype, "query", permissionsQuery, 1);
  }

  function isDefaultLocaleRequest(locales) {
    return locales === undefined || (Array.isArray(locales) && locales.length === 0);
  }

  function copyConstructorStatics(Native, Wrapped) {
    for (const key of Reflect.ownKeys(Native)) {
      if (key === "name" || key === "length" || key === "prototype") continue;
      try {
        Object.defineProperty(Wrapped, key, Object.getOwnPropertyDescriptor(Native, key));
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
    const descriptor = Object.getOwnPropertyDescriptor(container, property);
    let Wrapped = function () {
      const args = Array.prototype.slice.call(arguments);
      const finalArgs = buildArguments(args);
      if (!new.target) return Reflect.apply(Native, this, finalArgs);
      const target = new.target && new.target !== Wrapped ? new.target : Native;
      return Reflect.construct(Native, finalArgs, target);
    };
    registerOverride(Wrapped, property);
    disguiseAsNative(Wrapped, property, Native.length);
    try {
      Object.setPrototypeOf(Wrapped, Object.getPrototypeOf(Native));
      copyConstructorStatics(Native, Wrapped);
      Object.defineProperty(Wrapped, "prototype", {
        value: Native.prototype,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      const constructorDescriptor = Object.getOwnPropertyDescriptor(Native.prototype, "constructor");
      Object.defineProperty(Native.prototype, "constructor", {
        value: Wrapped,
        writable: constructorDescriptor ? constructorDescriptor.writable : true,
        enumerable: constructorDescriptor ? constructorDescriptor.enumerable : false,
        configurable: constructorDescriptor ? constructorDescriptor.configurable : true,
      });
    } catch (_) {
      // The important behavior is the native instance returned by Reflect.construct.
    }
    Object.defineProperty(container, property, {
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
    const languageDescriptor = Object.getOwnPropertyDescriptor(NavigatorPrototype, "language");
    if (languageDescriptor && typeof languageDescriptor.get === "function") {
      const nativeGetLanguage = languageDescriptor.get;
      installAccessor(NavigatorPrototype, "language", {
        get: function navigatorLanguageGetter() {
          const nativeValue = Reflect.apply(nativeGetLanguage, this, []);
          return protectionActive() && settings.localeEnabled ? settings.language : nativeValue;
        },
      });
    }
    const languagesDescriptor = Object.getOwnPropertyDescriptor(NavigatorPrototype, "languages");
    if (languagesDescriptor && typeof languagesDescriptor.get === "function") {
      const nativeGetLanguages = languagesDescriptor.get;
      let languagesKey;
      let spoofedLanguages;
      installAccessor(NavigatorPrototype, "languages", {
        get: function navigatorLanguagesGetter() {
          const nativeValue = Reflect.apply(nativeGetLanguages, this, []);
          const nextKey = JSON.stringify(settings.languages);
          if (nextKey !== languagesKey) {
            spoofedLanguages = realm.Object.freeze(realm.Array.from(settings.languages));
            languagesKey = nextKey;
          }
          return protectionActive() && settings.localeEnabled ? spoofedLanguages : nativeValue;
        },
      });
    }
  }

  function installLocaleMethod(target, property, localeIndex, optionsIndex, injectTimezone) {
    if (!target || typeof target[property] !== "function") return;
    const nativeMethod = target[property];
    installOverride(
      target,
      property,
      function localeAwareMethod() {
        const args = Array.prototype.slice.call(arguments);
        if (protectionActive() && settings.localeEnabled && isDefaultLocaleRequest(args[localeIndex])) {
          args[localeIndex] = settings.languages;
        }
        if (injectTimezone && protectionActive() && settings.timezoneEnabled) {
          const rawOptions = args[optionsIndex];
          if (rawOptions == null || rawOptions.timeZone === undefined) {
            args[optionsIndex] = Object.assign({}, rawOptions || {}, {
              timeZone: settings.timezone,
            });
          }
        }
        return Reflect.apply(nativeMethod, this, args);
      },
      nativeMethod.length
    );
  }

  function installLocaleMethods(realm) {
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
    for (const name of typedArrays) {
      const Constructor = realm[name];
      if (Constructor && Constructor.prototype) {
        installLocaleMethod(Constructor.prototype, "toLocaleString", 0, 1, false);
      }
    }
    installLocaleMethod(realm.Date && realm.Date.prototype, "toLocaleString", 0, 1, true);
    installLocaleMethod(realm.Date && realm.Date.prototype, "toLocaleDateString", 0, 1, true);
    installLocaleMethod(realm.Date && realm.Date.prototype, "toLocaleTimeString", 0, 1, true);
  }

  function installIntlOverrides(realm) {
    if (!realm.Intl) return;
    const names = [
      "Collator", "NumberFormat", "PluralRules", "RelativeTimeFormat",
      "ListFormat", "DisplayNames", "Segmenter", "DurationFormat",
    ];
    for (const name of names) {
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
          const rawOptions = args[1];
          if (rawOptions == null || rawOptions.timeZone === undefined) {
            args[1] = Object.assign({}, rawOptions || {}, {
              timeZone: settings.timezone,
            });
          }
        }
        return args;
      });
    }
  }

  function createZoneTools(realm, NativeDate, NativeDateTimeFormat) {
    const nativeGetTime = NativeDate.prototype.getTime;
    const nativeGetUTCMilliseconds = NativeDate.prototype.getUTCMilliseconds;
    let formatterZone;
    let partsFormatter;
    let zoneNameFormatter;
    function refreshFormatters() {
      if (formatterZone === settings.timezone) return;
      partsFormatter = new NativeDateTimeFormat("en-US-u-ca-gregory-nu-latn", {
        timeZone: settings.timezone,
        era: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      zoneNameFormatter = new NativeDateTimeFormat("en-US", {
        timeZone: settings.timezone,
        timeZoneName: "long",
      });
      formatterZone = settings.timezone;
    }
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    function epoch(value) {
      return Reflect.apply(nativeGetTime, value, []);
    }

    function parts(value) {
      const timestamp = epoch(value);
      if (!Number.isFinite(timestamp)) return null;
      refreshFormatters();
      const result = {};
      for (const part of partsFormatter.formatToParts(value)) {
        if (part.type !== "literal") result[part.type] = part.value;
      }
      const year = result.era === "BC" ? 1 - Number(result.year) : Number(result.year);
      const month = Number(result.month);
      const day = Number(result.day);
      return {
        year,
        month,
        day,
        hour: Number(result.hour) % 24,
        minute: Number(result.minute),
        second: Number(result.second),
        millisecond: Reflect.apply(nativeGetUTCMilliseconds, value, []),
        weekday: new NativeDate(wallEpoch({ year, month, day, hour: 0,
          minute: 0, second: 0, millisecond: 0 })).getUTCDay(),
      };
    }

    function offsetAt(timestamp) {
      const date = new NativeDate(timestamp);
      const value = parts(date);
      if (!value) return NaN;
      const wallAsUtc = wallEpoch(value);
      // Keep second-level historical offsets for wall-clock conversions.
      return (timestamp - wallAsUtc) / 60000;
    }

    function wallEpoch(values) {
      const numbers = [
        values.year, values.month, values.day, values.hour,
        values.minute, values.second, values.millisecond,
      ].map(Number);
      if (numbers.some((value) => !Number.isFinite(value))) return NaN;
      const date = new NativeDate(0);
      date.setUTCFullYear(numbers[0], numbers[1] - 1, numbers[2]);
      date.setUTCHours(numbers[3], numbers[4], numbers[5], numbers[6]);
      return epoch(date);
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
      if (!Number.isFinite(wall)) return NaN;

      const offsets = new Set();
      for (const days of [-370, -183, -2, -1, 0, 1, 2, 183, 370]) {
        const offset = offsetAt(wall + days * 86400000);
        if (Number.isFinite(offset)) offsets.add(offset);
      }
      let probe = wall;
      for (let index = 0; index < 4; index += 1) {
        const offset = offsetAt(probe);
        if (!Number.isFinite(offset)) break;
        offsets.add(offset);
        probe = wall + offset * 60000;
      }

      const candidates = [];
      for (const offset of offsets) {
        const candidate = wall + offset * 60000;
        const local = parts(new NativeDate(candidate));
        if (!local) continue;
        const localWall = wallEpoch(local);
        candidates.push({ candidate, difference: localWall - wall });
      }
      const exact = candidates
        .filter((item) => item.difference === 0)
        .sort((left, right) => left.candidate - right.candidate);
      if (exact.length) return exact[0].candidate;

      const afterGap = candidates
        .filter((item) => item.difference > 0)
        .sort((left, right) =>
          left.difference - right.difference || left.candidate - right.candidate
        );
      if (afterGap.length) return afterGap[0].candidate;
      const beforeGap = candidates.sort((left, right) =>
        right.difference - left.difference || left.candidate - right.candidate
      );
      return beforeGap.length ? beforeGap[0].candidate : NaN;
    }

    function offsetText(offset) {
      const sign = offset <= 0 ? "+" : "-";
      const absolute = Math.abs(Math.trunc(offset));
      return sign + String(Math.floor(absolute / 60)).padStart(2, "0") +
        String(absolute % 60).padStart(2, "0");
    }

    function zoneName(value) {
      refreshFormatters();
      const part = zoneNameFormatter.formatToParts(value).find((item) => item.type === "timeZoneName");
      return part ? part.value : settings.timezone;
    }

    function dateText(value) {
      const item = parts(value);
      if (!item) return "Invalid Date";
      return weekdayNames[item.weekday] + " " + monthNames[item.month - 1] + " " +
        String(item.day).padStart(2, "0") + " " + String(item.year).padStart(4, "0");
    }

    function timeText(value) {
      const item = parts(value);
      if (!item) return "Invalid Date";
      const offset = offsetAt(epoch(value));
      return String(item.hour).padStart(2, "0") + ":" +
        String(item.minute).padStart(2, "0") + ":" +
        String(item.second).padStart(2, "0") + " GMT" + offsetText(offset) +
        " (" + zoneName(value) + ")";
    }

    return { epoch, parts, offsetAt, wallEpoch, wallToEpoch, dateText, timeText };
  }

  function isAmbiguousDateString(value) {
    const source = String(value).trim();
    if (/^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/.test(source)) return false;
    return !(
      /Z$/i.test(source) ||
      /\b(?:UTC|GMT|[ECMP][SD]T)\b/i.test(source) ||
      /[+-]\d{2}(?::?\d{2})?(?:\s*\([^)]*\))?$/.test(source)
    );
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
      return Reflect.apply(native[method], receiver, Array.prototype.slice.call(args));
    }

    function currentParts(receiver, fullYearSpecial) {
      const timestamp = tools.epoch(receiver);
      if (Number.isFinite(timestamp)) return tools.parts(receiver);
      return fullYearSpecial
        ? { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }
        : null;
    }

    function commit(receiver, values) {
      const timestamp = tools.wallToEpoch(values);
      Reflect.apply(native.setTime, receiver, [timestamp]);
      return timestamp;
    }

    installOverride(prototype, "setHours", function setHours(hour, minute, second, ms) {
      if (!active()) return applyNative("setHours", this, arguments);
      try {
        const item = currentParts(this, false);
        if (!item) return NaN;
        return commit(this, {
          year: item.year, month: item.month, day: item.day,
          hour: Number(hour),
          minute: arguments.length >= 2 ? Number(minute) : item.minute,
          second: arguments.length >= 3 ? Number(second) : item.second,
          millisecond: arguments.length >= 4 ? Number(ms) : item.millisecond,
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
          minute: Number(minute),
          second: arguments.length >= 2 ? Number(second) : item.second,
          millisecond: arguments.length >= 3 ? Number(ms) : item.millisecond,
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
          minute: item.minute, second: Number(second),
          millisecond: arguments.length >= 2 ? Number(ms) : item.millisecond,
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
          year: item.year, month: item.month, day: Number(day), hour: item.hour,
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
          month: Number(month) + 1,
          day: arguments.length >= 2 ? Number(day) : item.day,
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
          year: Number(year),
          month: arguments.length >= 2 ? Number(month) + 1 : item.month,
          day: arguments.length >= 3 ? Number(day) : item.day,
          hour: item.hour, minute: item.minute, second: item.second,
          millisecond: Number.isFinite(tools.epoch(this)) ? item.millisecond : 0,
        });
      } catch (_) {
        return applyNative("setFullYear", this, arguments);
      }
    }, native.setFullYear.length);

    if (typeof native.setYear === "function") {
      installOverride(prototype, "setYear", function setYear(year) {
        if (!active()) return applyNative("setYear", this, arguments);
        try {
          let numericYear = Number(year);
          if (numericYear >= 0 && numericYear <= 99) numericYear += 1900;
          const item = currentParts(this, true);
          if (!item) return applyNative("setYear", this, arguments);
          return commit(this, {
            year: numericYear, month: item.month, day: item.day, hour: item.hour,
            minute: item.minute, second: item.second,
            millisecond: Number.isFinite(tools.epoch(this)) ? item.millisecond : 0,
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
    const pad = (value, length) => String(value).padStart(length, "0");
    const rewrite = (value) => value.replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g,
      (match, fractional) => {
        const instant = new NativeDate(match);
        const timestamp = instant.getTime();
        if (
          !protectionActive() ||
          !settings.timezoneEnabled ||
          !Number.isFinite(timestamp) ||
          Math.abs(timestamp - NativeDate.now()) > 120000
        ) return match;
        const item = tools.parts(instant);
        if (!item) return match;
        const offset = tools.offsetAt(timestamp);
        const sign = offset <= 0 ? "+" : "-";
        const absolute = Math.abs(Math.trunc(offset));
        return pad(item.year, 4) + "-" + pad(item.month, 2) + "-" + pad(item.day, 2) +
          "T" + pad(item.hour, 2) + ":" + pad(item.minute, 2) + ":" +
          pad(item.second, 2) + (fractional || "") + sign +
          pad(Math.floor(absolute / 60), 2) + ":" + pad(absolute % 60, 2);
      }
    );
    const rewriteTree = (node) => {
      if (!node) return;
      if (node.nodeType === 3 && typeof node.nodeValue === "string") {
        node.nodeValue = rewrite(node.nodeValue);
      }
      for (const child of Array.from(node.childNodes || [])) rewriteTree(child);
    };
    for (const property of ["transformToFragment", "transformToDocument"]) {
      const nativeMethod = Constructor.prototype[property];
      if (typeof nativeMethod !== "function") continue;
      installOverride(Constructor.prototype, property, function xsltTransform() {
        const result = Reflect.apply(nativeMethod, this, Array.prototype.slice.call(arguments));
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
    const descriptor = Object.getOwnPropertyDescriptor(DocumentPrototype, "lastModified");
    if (!descriptor || typeof descriptor.get !== "function") return;
    const nativeGet = descriptor.get;
    installAccessor(DocumentPrototype, "lastModified", {
      get: function documentLastModifiedGetter() {
        const nativeValue = Reflect.apply(nativeGet, this, []);
        if (!protectionActive() || !settings.timezoneEnabled) return nativeValue;
        const parsed = new NativeDate(nativeValue);
        const item = tools.parts(parsed);
        if (!item) return nativeValue;
        return String(item.month).padStart(2, "0") + "/" +
          String(item.day).padStart(2, "0") + "/" +
          String(item.year).padStart(4, "0") + " " +
          String(item.hour).padStart(2, "0") + ":" +
          String(item.minute).padStart(2, "0") + ":" +
          String(item.second).padStart(2, "0");
      },
    });
  }

  function installDateOverrides(realm, NativeDate, NativeDateTimeFormat) {
    if (!realm.Date || !NativeDate || !settings.timezone) return;
    const tools = createZoneTools(realm, NativeDate, NativeDateTimeFormat);
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
    for (const property of Object.keys(partKeys)) {
      installOverride(
        prototype,
        property,
        function timezoneDateGetter() {
          const nativeValue = Reflect.apply(nativeGetters[property], this, []);
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
        const nativeValue = Reflect.apply(nativeGetters.getTimezoneOffset, this, []);
        if (!protectionActive() || !settings.timezoneEnabled) return nativeValue;
        const offset = tools.offsetAt(tools.epoch(this));
        return Number.isNaN(offset) ? NaN : Math.trunc(offset) || 0;
      },
      0
    );
    installOverride(
      prototype,
      "toDateString",
      function toDateString() {
        const nativeValue = Reflect.apply(nativeGetters.toDateString, this, []);
        return protectionActive() && settings.timezoneEnabled ? tools.dateText(this) : nativeValue;
      },
      0
    );
    installOverride(
      prototype,
      "toTimeString",
      function toTimeString() {
        const nativeValue = Reflect.apply(nativeGetters.toTimeString, this, []);
        return protectionActive() && settings.timezoneEnabled ? tools.timeText(this) : nativeValue;
      },
      0
    );
    installOverride(
      prototype,
      "toString",
      function toString() {
        const nativeValue = Reflect.apply(nativeGetters.toString, this, []);
        return protectionActive() && settings.timezoneEnabled && Number.isFinite(tools.epoch(this))
          ? tools.dateText(this) + " " + tools.timeText(this)
          : nativeValue;
      },
      0
    );

    installDateSetterOverrides(prototype, NativeDate, tools);
    installXsltOverrides(realm, NativeDate, tools);
    installDocumentOverrides(realm, NativeDate, tools);

    const nativeDateParse = NativeDate.parse;
    function parseTargetLocalString(value) {
      const parsed = new NativeDate(value);
      const timestamp = Reflect.apply(nativeGetters.getTime || prototype.getTime, parsed, []);
      if (!Number.isFinite(timestamp) || !isAmbiguousDateString(value)) return timestamp;
      return tools.wallToEpoch({
        year: Reflect.apply(nativeGetters.getFullYear, parsed, []),
        month: Reflect.apply(nativeGetters.getMonth, parsed, []) + 1,
        day: Reflect.apply(nativeGetters.getDate, parsed, []),
        hour: Reflect.apply(nativeGetters.getHours, parsed, []),
        minute: Reflect.apply(nativeGetters.getMinutes, parsed, []),
        second: Reflect.apply(nativeGetters.getSeconds, parsed, []),
        millisecond: Reflect.apply(nativeGetters.getMilliseconds, parsed, []),
      });
    }

    const globalDescriptor = Object.getOwnPropertyDescriptor(realm, "Date");
    let WrappedDate = function Date() {
      const args = Array.prototype.slice.call(arguments);
      if (!new.target) {
        if (!protectionActive() || !settings.timezoneEnabled) return NativeDate();
        const now = new NativeDate();
        return tools.dateText(now) + " " + tools.timeText(now);
      }
      if (!protectionActive() || !settings.timezoneEnabled) {
        const target = new.target === WrappedDate ? NativeDate : new.target;
        return Reflect.construct(NativeDate, args, target);
      }
      if (args.length === 1) {
        const target = new.target === WrappedDate ? NativeDate : new.target;
        if (typeof args[0] === "string" && isAmbiguousDateString(args[0])) {
          return Reflect.construct(NativeDate, [parseTargetLocalString(args[0])], target);
        }
        return Reflect.construct(NativeDate, args, target);
      }
      if (args.length < 2) {
        const target = new.target === WrappedDate ? NativeDate : new.target;
        return Reflect.construct(NativeDate, args, target);
      }
      let year = Number(args[0]);
      if (year >= 0 && year <= 99) year += 1900;
      const timestamp = tools.wallToEpoch({
        year,
        month: Number(args[1]) + 1,
        day: args.length > 2 ? Number(args[2]) : 1,
        hour: args.length > 3 ? Number(args[3]) : 0,
        minute: args.length > 4 ? Number(args[4]) : 0,
        second: args.length > 5 ? Number(args[5]) : 0,
        millisecond: args.length > 6 ? Number(args[6]) : 0,
      });
      const target = new.target === WrappedDate ? NativeDate : new.target;
      return Reflect.construct(NativeDate, [timestamp], target);
    };
    registerOverride(WrappedDate, "Date");
    disguiseAsNative(WrappedDate, "Date", NativeDate.length);
    Object.setPrototypeOf(WrappedDate, Object.getPrototypeOf(NativeDate));
    copyConstructorStatics(NativeDate, WrappedDate);
    const wrappedParse = function parse(value) {
      if (!protectionActive() || !settings.timezoneEnabled) {
        return Reflect.apply(nativeDateParse, NativeDate, arguments);
      }
      const stringValue = typeof value === "string" ? value : "" + value;
      if (!isAmbiguousDateString(stringValue)) {
        return Reflect.apply(nativeDateParse, NativeDate, [stringValue]);
      }
      return parseTargetLocalString(stringValue);
    };
    registerOverride(wrappedParse, "parse");
    disguiseAsNative(wrappedParse, "parse", nativeDateParse.length);
    Object.defineProperty(WrappedDate, "parse", {
      value: wrappedParse,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(WrappedDate, "prototype", {
      value: NativeDate.prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const dateConstructorDescriptor =
      Object.getOwnPropertyDescriptor(NativeDate.prototype, "constructor");
    Object.defineProperty(NativeDate.prototype, "constructor", {
      value: WrappedDate,
      writable: dateConstructorDescriptor ? dateConstructorDescriptor.writable : true,
      enumerable: dateConstructorDescriptor ? dateConstructorDescriptor.enumerable : false,
      configurable: dateConstructorDescriptor ? dateConstructorDescriptor.configurable : true,
    });
    Object.defineProperty(realm, "Date", {
      value: WrappedDate,
      configurable: globalDescriptor ? globalDescriptor.configurable : true,
      enumerable: globalDescriptor ? globalDescriptor.enumerable : false,
      writable: globalDescriptor ? globalDescriptor.writable : true,
    });
  }

  function installEnvironmentOverrides(realm) {
    const NativeDate = realm.Date;
    const NativeDateTimeFormat = realm.Intl && realm.Intl.DateTimeFormat;
    installNavigatorLocale(realm);
    installDateOverrides(realm, NativeDate, NativeDateTimeFormat);
    installIntlOverrides(realm);
    installLocaleMethods(realm);
  }

  function patchWindow(realm) {
    if (!realm) return false;
    let documentMarker;
    try {
      documentMarker = realm.document;
    } catch (_) {
      return false;
    }
    if (patchedWindows.get(realm) === documentMarker || sharedRealms.documents.has(documentMarker)) return false;
    try {
      patchedWindows.set(realm, documentMarker);
      sharedRealms.documents.add(documentMarker);
      installFunctionMaskingOn(realm);
      installEnvironmentOverrides(realm);
      installWorkerPatching(realm);
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
        reportError: typeof realm.reportError === "function" ? realm.reportError.bind(realm) : null,
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
    }
  }

  function tryPatchIframe(iframe) {
    if (!iframe || String(iframe.tagName).toUpperCase() !== "IFRAME") return;
    try {
      patchWindow(iframe.contentWindow);
    } catch (_) {
      // Cross-origin frame: inaccessible by design.
    }
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
    if (!node || node.nodeType !== 1) return;
    if (String(node.tagName).toUpperCase() === "IFRAME") tryPatchIframe(node);
    if (typeof node.querySelectorAll === "function") {
      for (const iframe of node.querySelectorAll("iframe")) tryPatchIframe(iframe);
    }
  }

  function installIframeCoverage() {
    if (typeof HTMLIFrameElement !== "undefined") {
      for (const property of ["contentWindow", "contentDocument"]) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, property);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGetter = descriptor.get;
        installAccessor(HTMLIFrameElement.prototype, property, {
          get: function iframeRealmGetter() {
            const value = Reflect.apply(nativeGetter, this, []);
            try {
              const iframeWindow =
                property === "contentWindow" ? value : value && value.defaultView;
              if (iframeWindow) patchWindow(iframeWindow);
            } catch (_) {
              // Cross-origin frame.
            }
            return value;
          },
        });
      }
    }

    const startObserver = () => {
      if (!document.documentElement) return;
      for (const iframe of document.querySelectorAll("iframe")) tryPatchIframe(iframe);
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) scanNodeForIframes(node);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }

  function workerBootstrap(config) {
    "use strict";
    const nativeToString = Function.prototype.toString;
    const nativeNames = new WeakMap();
    const mark = (fn, name, length) => {
      nativeNames.set(fn, name);
      try {
        Object.defineProperty(fn, "name", { value: name, configurable: true });
        if (Number.isInteger(length)) {
          Object.defineProperty(fn, "length", { value: length, configurable: true });
        }
      } catch (_) {}
      return fn;
    };
    Function.prototype.toString = mark({
      toString() {
        const name = nativeNames.get(this);
        return name ? "function " + name + "() { [native code] }" :
          Reflect.apply(nativeToString, this, []);
      },
    }.toString, "toString");

    const defaultLocales = (locales) =>
      locales === undefined || (Array.isArray(locales) && locales.length === 0);
    const languageList = Object.freeze(Array.from(config.languages));
    const NavigatorConstructor =
      typeof WorkerNavigator === "function" ? WorkerNavigator :
        (typeof Navigator === "function" ? Navigator : null);
    if (config.localeEnabled && NavigatorConstructor) {
      for (const property of ["language", "languages"]) {
        const descriptor = Object.getOwnPropertyDescriptor(NavigatorConstructor.prototype, property);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        const nativeGet = descriptor.get;
        const getter = mark({
          get value() {
            const nativeValue = Reflect.apply(nativeGet, this, []);
            return property === "language" ? config.language : languageList;
          },
        }.__lookupGetter__("value"), "get " + property);
        Object.defineProperty(NavigatorConstructor.prototype, property, {
          get: getter,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
        });
      }
    }

    const wrapIntl = (name, injectTimezone) => {
      const Native = Intl[name];
      if (typeof Native !== "function") return;
      let Wrapped = function () {
        const args = Array.prototype.slice.call(arguments);
        if (config.localeEnabled && defaultLocales(args[0])) args[0] = config.languages;
        if (injectTimezone && config.timezoneEnabled) {
          const options = args[1];
          if (options == null || options.timeZone === undefined) {
            args[1] = Object.assign({}, options || {}, { timeZone: config.timezone });
          }
        }
        const target = new.target && new.target !== Wrapped ? new.target : Native;
        if (!new.target) return Reflect.apply(Native, this, args);
        return Reflect.construct(Native, args, target);
      };
      mark(Wrapped, name, Native.length);
      Object.setPrototypeOf(Wrapped, Object.getPrototypeOf(Native));
      for (const key of Reflect.ownKeys(Native)) {
        if (key === "name" || key === "length" || key === "prototype") continue;
        try {
          Object.defineProperty(Wrapped, key, Object.getOwnPropertyDescriptor(Native, key));
        } catch (_) {}
      }
      Object.defineProperty(Wrapped, "prototype", {
        value: Native.prototype,
        writable: false,
        configurable: false,
      });
      const constructorDescriptor = Object.getOwnPropertyDescriptor(Native.prototype, "constructor");
      Object.defineProperty(Native.prototype, "constructor", {
        value: Wrapped,
        writable: constructorDescriptor ? constructorDescriptor.writable : true,
        enumerable: constructorDescriptor ? constructorDescriptor.enumerable : false,
        configurable: constructorDescriptor ? constructorDescriptor.configurable : true,
      });
      Intl[name] = Wrapped;
    };
    for (const name of [
      "Collator", "NumberFormat", "PluralRules", "RelativeTimeFormat",
      "ListFormat", "DisplayNames", "Segmenter", "DurationFormat",
    ]) wrapIntl(name, false);

    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const NativeDate = Date;
    const nativeGetTime = NativeDate.prototype.getTime;
    const nativeGetUTCMilliseconds = NativeDate.prototype.getUTCMilliseconds;
    const nativeDateMethods = {};
    for (const name of [
      "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes",
      "getSeconds", "getMilliseconds", "getYear", "getTimezoneOffset", "toString",
      "setHours", "setMinutes", "setSeconds", "setDate", "setMonth", "setFullYear",
      "setYear", "setTime",
    ]) nativeDateMethods[name] = NativeDate.prototype[name];
    let partsFormatter = null;
    let zoneNameFormatter = null;
    if (config.timezoneEnabled) {
      partsFormatter = new NativeDateTimeFormat("en-US-u-ca-gregory-nu-latn", {
        timeZone: config.timezone,
        era: "short",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
      });
      zoneNameFormatter = new NativeDateTimeFormat("en-US", {
        timeZone: config.timezone,
        timeZoneName: "long",
      });
    }
    wrapIntl("DateTimeFormat", true);

    const epoch = (value) => Reflect.apply(nativeGetTime, value, []);
    const zoneParts = (value) => {
      const timestamp = epoch(value);
      if (!Number.isFinite(timestamp) || !partsFormatter) return null;
      const record = {};
      for (const part of partsFormatter.formatToParts(value)) {
        if (part.type !== "literal") record[part.type] = part.value;
      }
      const year = record.era === "BC" ? 1 - Number(record.year) : Number(record.year);
      const month = Number(record.month);
      const day = Number(record.day);
      return {
        year, month, day,
        hour: Number(record.hour) % 24,
        minute: Number(record.minute),
        second: Number(record.second),
        millisecond: Reflect.apply(nativeGetUTCMilliseconds, value, []),
        weekday: new NativeDate(wallEpoch({ year, month, day, hour: 0,
          minute: 0, second: 0, millisecond: 0 })).getUTCDay(),
      };
    };
    const offsetAt = (timestamp) => {
      const value = zoneParts(new NativeDate(timestamp));
      if (!value) return NaN;
      const wall = wallEpoch(value);
      return (timestamp - wall) / 60000;
    };
    const wallEpoch = (value) => {
      const list = [
        value.year, value.month, value.day, value.hour,
        value.minute, value.second, value.millisecond,
      ].map(Number);
      if (list.some((item) => !Number.isFinite(item))) return NaN;
      const date = new NativeDate(0);
      date.setUTCFullYear(list[0], list[1] - 1, list[2]);
      date.setUTCHours(list[3], list[4], list[5], list[6]);
      return epoch(date);
    };
    const wallToEpoch = (value) => {
      const wall = wallEpoch(value);
      if (!Number.isFinite(wall)) return NaN;
      const offsets = new Set();
      for (const days of [-370, -183, -2, -1, 0, 1, 2, 183, 370]) {
        const offset = offsetAt(wall + days * 86400000);
        if (Number.isFinite(offset)) offsets.add(offset);
      }
      const candidates = Array.from(offsets).map((offset) => {
        const candidate = wall + offset * 60000;
        const local = zoneParts(new NativeDate(candidate));
        return {
          candidate,
          difference: local ? wallEpoch(local) - wall : Infinity,
        };
      });
      const exact = candidates
        .filter((item) => item.difference === 0)
        .sort((left, right) => left.candidate - right.candidate);
      if (exact.length) return exact[0].candidate;
      const after = candidates
        .filter((item) => item.difference > 0)
        .sort((left, right) => left.difference - right.difference);
      return after.length ? after[0].candidate : NaN;
    };
    const getters = {
      getFullYear: "year", getMonth: "month", getDate: "day", getDay: "weekday",
      getHours: "hour", getMinutes: "minute", getSeconds: "second",
      getMilliseconds: "millisecond", getYear: "year",
    };
    if (config.timezoneEnabled) {
      for (const property of Object.keys(getters)) {
        const nativeMethod = nativeDateMethods[property];
        const override = mark({
          [property]() {
            const nativeValue = Reflect.apply(nativeMethod, this, []);
            const value = zoneParts(this);
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
          Reflect.apply(nativeOffset, this, []);
          const offset = offsetAt(epoch(this));
          return Number.isNaN(offset) ? NaN : Math.trunc(offset) || 0;
        },
      }.getTimezoneOffset, "getTimezoneOffset");

      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const nativeString = nativeDateMethods.toString;
      NativeDate.prototype.toString = mark({
        toString() {
          const fallback = Reflect.apply(nativeString, this, []);
          const value = zoneParts(this);
          if (!value) return fallback;
          const offset = offsetAt(epoch(this));
          const sign = offset <= 0 ? "+" : "-";
          const absolute = Math.abs(Math.trunc(offset));
          const offsetText = sign + String(Math.floor(absolute / 60)).padStart(2, "0") +
            String(absolute % 60).padStart(2, "0");
          const zonePart = zoneNameFormatter.formatToParts(this)
            .find((item) => item.type === "timeZoneName");
          return weekdays[value.weekday] + " " + months[value.month - 1] + " " +
            String(value.day).padStart(2, "0") + " " + String(value.year).padStart(4, "0") + " " +
            String(value.hour).padStart(2, "0") + ":" + String(value.minute).padStart(2, "0") +
            ":" + String(value.second).padStart(2, "0") + " GMT" + offsetText +
            " (" + (zonePart ? zonePart.value : config.timezone) + ")";
        },
      }.toString, "toString");

      const applySetter = (property, receiver, args) => {
        const nativeMethod = nativeDateMethods[property];
        try {
          const timestamp = epoch(receiver);
          let item = Number.isFinite(timestamp)
            ? zoneParts(receiver)
            : (property === "setFullYear" || property === "setYear"
              ? { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }
              : null);
          if (!item) return Reflect.apply(nativeMethod, receiver, args);
          const values = {
            year: item.year, month: item.month, day: item.day, hour: item.hour,
            minute: item.minute, second: item.second,
            millisecond: Number.isFinite(timestamp) ? item.millisecond : 0,
          };
          if (property === "setHours") {
            values.hour = Number(args[0]);
            if (args.length >= 2) values.minute = Number(args[1]);
            if (args.length >= 3) values.second = Number(args[2]);
            if (args.length >= 4) values.millisecond = Number(args[3]);
          } else if (property === "setMinutes") {
            values.minute = Number(args[0]);
            if (args.length >= 2) values.second = Number(args[1]);
            if (args.length >= 3) values.millisecond = Number(args[2]);
          } else if (property === "setSeconds") {
            values.second = Number(args[0]);
            if (args.length >= 2) values.millisecond = Number(args[1]);
          } else if (property === "setDate") {
            values.day = Number(args[0]);
          } else if (property === "setMonth") {
            values.month = Number(args[0]) + 1;
            if (args.length >= 2) values.day = Number(args[1]);
          } else if (property === "setFullYear") {
            values.year = Number(args[0]);
            if (args.length >= 2) values.month = Number(args[1]) + 1;
            if (args.length >= 3) values.day = Number(args[2]);
          } else if (property === "setYear") {
            values.year = Number(args[0]);
            if (values.year >= 0 && values.year <= 99) values.year += 1900;
          }
          const result = wallToEpoch(values);
          Reflect.apply(nativeDateMethods.setTime, receiver, [result]);
          return result;
        } catch (_) {
          return Reflect.apply(nativeMethod, receiver, args);
        }
      };
      for (const property of [
        "setHours", "setMinutes", "setSeconds", "setDate", "setMonth",
        "setFullYear", "setYear",
      ]) {
        if (typeof nativeDateMethods[property] !== "function") continue;
        NativeDate.prototype[property] = mark({
          [property]() {
            return applySetter(property, this, Array.prototype.slice.call(arguments));
          },
        }[property], property, nativeDateMethods[property].length);
      }

      const ambiguous = (value) => {
        const source = String(value).trim();
        if (/^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/.test(source)) return false;
        return !(
          /Z$/i.test(source) ||
          /\b(?:UTC|GMT|[ECMP][SD]T)\b/i.test(source) ||
          /[+-]\d{2}(?::?\d{2})?(?:\s*\([^)]*\))?$/.test(source)
        );
      };
      const parseTarget = (source) => {
        const parsed = new NativeDate(source);
        const timestamp = epoch(parsed);
        if (!Number.isFinite(timestamp) || !ambiguous(source)) return timestamp;
        return wallToEpoch({
          year: Reflect.apply(nativeDateMethods.getFullYear, parsed, []),
          month: Reflect.apply(nativeDateMethods.getMonth, parsed, []) + 1,
          day: Reflect.apply(nativeDateMethods.getDate, parsed, []),
          hour: Reflect.apply(nativeDateMethods.getHours, parsed, []),
          minute: Reflect.apply(nativeDateMethods.getMinutes, parsed, []),
          second: Reflect.apply(nativeDateMethods.getSeconds, parsed, []),
          millisecond: Reflect.apply(nativeDateMethods.getMilliseconds, parsed, []),
        });
      };
      let WrappedDate = function Date() {
        const args = Array.prototype.slice.call(arguments);
        if (!new.target) return new NativeDate().toString();
        const target = new.target === WrappedDate ? NativeDate : new.target;
        if (args.length === 1) {
          return typeof args[0] === "string" && ambiguous(args[0])
            ? Reflect.construct(NativeDate, [parseTarget(args[0])], target)
            : Reflect.construct(NativeDate, args, target);
        }
        if (args.length >= 2) {
          let year = Number(args[0]);
          if (year >= 0 && year <= 99) year += 1900;
          const timestamp = wallToEpoch({
            year,
            month: Number(args[1]) + 1,
            day: args.length > 2 ? Number(args[2]) : 1,
            hour: args.length > 3 ? Number(args[3]) : 0,
            minute: args.length > 4 ? Number(args[4]) : 0,
            second: args.length > 5 ? Number(args[5]) : 0,
            millisecond: args.length > 6 ? Number(args[6]) : 0,
          });
          return Reflect.construct(NativeDate, [timestamp], target);
        }
        return Reflect.construct(NativeDate, args, target);
      };
      mark(WrappedDate, "Date", NativeDate.length);
      Object.setPrototypeOf(WrappedDate, Object.getPrototypeOf(NativeDate));
      for (const key of Reflect.ownKeys(NativeDate)) {
        if (key === "name" || key === "length" || key === "prototype" || key === "parse") continue;
        try {
          Object.defineProperty(WrappedDate, key, Object.getOwnPropertyDescriptor(NativeDate, key));
        } catch (_) {}
      }
      Object.defineProperty(WrappedDate, "prototype", {
        value: NativeDate.prototype,
        writable: false,
        configurable: false,
      });
      const wrappedParse = mark({
        parse(value) {
          const source = typeof value === "string" ? value : "" + value;
          return ambiguous(source) ? parseTarget(source) : NativeDate.parse(source);
        },
      }.parse, "parse", NativeDate.parse.length);
      Object.defineProperty(WrappedDate, "parse", {
        value: wrappedParse,
        writable: true,
        configurable: true,
      });
      const dateConstructorDescriptor =
        Object.getOwnPropertyDescriptor(NativeDate.prototype, "constructor");
      Object.defineProperty(NativeDate.prototype, "constructor", {
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
        [property]() {
          const args = Array.prototype.slice.call(arguments);
          if (config.localeEnabled && defaultLocales(args[localeIndex])) {
            args[localeIndex] = config.languages;
          }
          if (withTimezone && config.timezoneEnabled) {
            const options = args[optionsIndex];
            if (options == null || options.timeZone === undefined) {
              args[optionsIndex] = Object.assign({}, options || {}, {
                timeZone: config.timezone,
              });
            }
          }
          return Reflect.apply(nativeMethod, this, args);
        },
      }[property], property, nativeMethod.length);
    };
    localeMethod(Number.prototype, "toLocaleString", 0, 1, false);
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
          const urls = Array.prototype.map.call(arguments, (url) =>
            new URL(String(url), config.baseUrl).href
          );
          return Reflect.apply(nativeImportScripts, self, urls);
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
    return "(" + callOriginalToString(workerBootstrap) + ")(" + JSON.stringify(config) + ");";
  }

  function decodeDataWorker(url) {
    const match = /^data:([^,]*?),(.*)$/s.exec(url);
    if (!match) return null;
    try {
      return /;base64(?:;|$)/i.test(match[1])
        ? decodeURIComponent(escape(atob(match[2])))
        : decodeURIComponent(match[2]);
    } catch (_) {
      return null;
    }
  }

  function installWorkerPatching(realm) {
    if (!realm || patchedWorkerRealms.has(realm.document) || typeof realm.Worker !== "function") return;
    patchedWorkerRealms.add(realm.document);
    const RealWorker = realm.Worker;
    const NativeBlob = realm.Blob;
    const NativeURL = realm.URL;
    if (!NativeBlob || !NativeURL || typeof NativeURL.createObjectURL !== "function") return;
    const nativeCreateObjectURL = NativeURL.createObjectURL;
    const nativeRevokeObjectURL = NativeURL.revokeObjectURL;
    const trackedBlobs = new Map();

    installOverride(
      NativeURL,
      "createObjectURL",
      function createObjectURL(value) {
        const url = Reflect.apply(nativeCreateObjectURL, NativeURL, [value]);
        if (value instanceof NativeBlob) trackedBlobs.set(url, value);
        return url;
      },
      1
    );
    installOverride(
      NativeURL,
      "revokeObjectURL",
      function revokeObjectURL(url) {
        trackedBlobs.delete(String(url));
        return Reflect.apply(nativeRevokeObjectURL, NativeURL, [url]);
      },
      1
    );

    function patchedBlobUrl(parts) {
      const blob = new NativeBlob(parts, { type: "text/javascript" });
      return Reflect.apply(nativeCreateObjectURL, NativeURL, [blob]);
    }

    let WrappedWorker = function Worker(scriptURL, options) {
      if (!new.target) return Reflect.apply(RealWorker, this, arguments);
      if (
        !protectionActive() ||
        !settings.workerEnabled ||
        (!settings.localeEnabled && !settings.timezoneEnabled)
      ) {
        return new RealWorker(scriptURL, options);
      }
      const rawUrl = String(scriptURL);
      const isModule = !!(options && options.type === "module");
      try {
        if (rawUrl.startsWith("blob:")) {
          const originalBlob = trackedBlobs.get(rawUrl);
          if (!originalBlob) return new RealWorker(scriptURL, options);
          const payload = buildWorkerPayload(realm.location.href);
          return new RealWorker(patchedBlobUrl([payload, "\n", originalBlob]), options);
        }
        if (rawUrl.startsWith("data:")) {
          const source = decodeDataWorker(rawUrl);
          if (source == null) return new RealWorker(scriptURL, options);
          return new RealWorker(
            patchedBlobUrl([buildWorkerPayload(realm.location.href), "\n", source]),
            options
          );
        }
        if (settings.patchUrlWorkers) {
          const absoluteUrl = new NativeURL(rawUrl, realm.location.href).href;
          const payload = buildWorkerPayload(absoluteUrl);
          const bootstrap = isModule
            ? payload + "\nimport " + JSON.stringify(absoluteUrl) + ";"
            : payload + "\nimportScripts(" + JSON.stringify(absoluteUrl) + ");";
          return new RealWorker(patchedBlobUrl([bootstrap]), options);
        }
      } catch (error) {
        log("Worker wrapping failed; using native Worker", error);
      }
      return new RealWorker(scriptURL, options);
    };
    registerOverride(WrappedWorker, "Worker");
    disguiseAsNative(WrappedWorker, "Worker", RealWorker.length);
    Object.setPrototypeOf(WrappedWorker, Object.getPrototypeOf(RealWorker));
    Object.defineProperty(WrappedWorker, "prototype", {
      value: RealWorker.prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const workerConstructorDescriptor =
      Object.getOwnPropertyDescriptor(RealWorker.prototype, "constructor");
    Object.defineProperty(RealWorker.prototype, "constructor", {
      value: WrappedWorker,
      writable: workerConstructorDescriptor ? workerConstructorDescriptor.writable : true,
      enumerable: workerConstructorDescriptor ? workerConstructorDescriptor.enumerable : false,
      configurable: workerConstructorDescriptor ? workerConstructorDescriptor.configurable : true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(realm, "Worker");
    Object.defineProperty(realm, "Worker", {
      value: WrappedWorker,
      configurable: descriptor ? descriptor.configurable : true,
      enumerable: descriptor ? descriptor.enumerable : false,
      writable: descriptor ? descriptor.writable : true,
    });
  }

  function element(tag, properties) {
    const node = document.createElement(tag);
    if (properties) Object.assign(node, properties);
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
    Object.assign(host.style, {
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
      workingProfiles.forEach((profile, index) => {
        byId("profileSelect").appendChild(new Option(profile.name, String(index)));
      });
      if (workingProfiles[Number(selected)]) byId("profileSelect").value = selected;
    };
    const updateScopePreview = () => {
      const mode = byId("siteMode").value;
      const patterns = byId("sitePatterns").value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const invalid = patterns.filter((value) => !parseSitePattern(value));
      const matchedPatterns = patterns.filter((value) =>
        sitePatternMatches(value, location.href)
      );
      const matched = matchedPatterns.length > 0;
      const active = byId("enabled").checked &&
        (mode === "all" || (mode === "allowlist" ? matched : !matched));
      let preview = "当前页面：" + (active ? "会启用伪装" : "不会启用伪装");
      if (mode === "all" && patterns.length) {
        preview += "；所有网站模式下，规则列表暂不参与判断";
      } else if (matchedPatterns.length) {
        preview += "；匹配规则：" + matchedPatterns.join("、");
      }
      preview += "；共 " + patterns.length + " 条规则";
      byId("scopePreview").textContent = invalid.length
        ? "无效规则：" + invalid.join("、")
        : preview;
      byId("scopePreview").style.color = invalid.length ? "#fca5a5" : "#bfdbfe";
      const features = ["定位"];
      if (byId("timezoneEnabled").checked) features.push("时区");
      if (byId("localeEnabled").checked) features.push("实验性语言");
      if (byId("workerEnabled").checked) features.push("Worker");
      byId("currentStatus").textContent = active
        ? "当前保护状态：已启用（" + features.join("、") + "）"
        : "当前保护状态：未启用；请检查总开关和网站范围。";
      byId("currentStatus").style.color = active ? "#86efac" : "#fbbf24";
    };
    const updatePrecisionPreview = () => {
      const enabled = byId("approximateEnabled").checked;
      const radius = Number(byId("approximateRadius").value);
      byId("approximateRadius").disabled = !enabled;
      byId("regenerateApproximate").disabled = !enabled;
      const latitude = Number(byId("latitude").value);
      const longitude = Number(byId("longitude").value);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
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
        ? "网页将稳定收到：" + reported.latitude.toFixed(8) + ", " +
          reported.longitude.toFixed(8) + "（位于锚点半径内）"
        : "网页将收到所填锚点坐标；低位仍会做原生外观填充。";
    };
    const applyParsedCoordinates = (source) => {
      const parsed = parseCoordinateText(source);
      if (!parsed) {
        byId("error").style.color = "#fca5a5";
        byId("error").textContent = "无法识别坐标。请使用十进制、DMS、Geohash 或包含坐标的地图链接。";
        return false;
      }
      byId("latitude").value = String(Number(parsed.latitude.toFixed(8)));
      byId("longitude").value = String(Number(parsed.longitude.toFixed(8)));
      updatePrecisionPreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已解析坐标；保存并刷新后生效。";
      return true;
    };
    const updateVpnStatus = () => {
      const network = readNetworkState();
      const parts = [];
      if (network.lastSyncAt) {
        parts.push("上次同步：" + new Date(network.lastSyncAt).toLocaleString());
        if (network.lastSyncLabel) parts.push(network.lastSyncLabel);
        if (network.lastIp) parts.push(network.lastIp);
      } else {
        parts.push("尚未同步 VPN 出口");
      }
      if (network.lastError) parts.push("上次错误：" + network.lastError);
      byId("vpnStatus").textContent = parts.join("；");
      byId("vpnCheckMinutes").disabled = !byId("vpnAutoSync").checked;
    };
    const applyTimezoneForFormCoordinates = async (label) => {
      const latitude = Number(byId("latitude").value);
      const longitude = Number(byId("longitude").value);
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
      for (const [index, result] of results.entries()) {
        const button = element("button", {
          id: "cityResult" + index,
          type: "button",
          className: "search-result",
          textContent: result.name,
        });
        button.addEventListener("click", async () => {
          byId("latitude").value = String(result.latitude);
          byId("longitude").value = String(result.longitude);
          byId("coordinateText").value = result.latitude + ", " + result.longitude;
          byId("profileName").value = [result.city, result.country].filter(Boolean).join(", ") ||
            result.name.slice(0, 40);
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
      byId("latitude").value = String(value.latitude);
      byId("longitude").value = String(value.longitude);
      byId("accuracy").value = String(value.accuracy);
      byId("approximateEnabled").checked = value.approximateEnabled;
      byId("approximateRadius").value = String(value.approximateRadius);
      workingApproximateSeed = value.approximateSeed > 0
        ? value.approximateSeed
        : randomSeed();
      byId("prompt").checked = value.preservePermissionPrompt;
      byId("localeEnabled").checked = value.localeEnabled;
      byId("language").value = value.language;
      byId("languages").value = value.languages.join(", ");
      byId("timezoneEnabled").checked = value.timezoneEnabled;
      byId("timezone").value = value.timezone;
      byId("workerEnabled").checked = value.workerEnabled;
      byId("patchUrlWorkers").checked = value.patchUrlWorkers;
      byId("siteMode").value = value.siteMode;
      byId("sitePatterns").value = value.sitePatterns.join("\n");
      byId("vpnAutoSync").checked = value.vpnAutoSync;
      byId("vpnCheckMinutes").value = String(value.vpnCheckMinutes);
      byId("floatingButtonEnabled").checked = value.floatingButtonEnabled;
      workingProfiles = value.profiles.map((profile) => ({ ...profile }));
      renderProfiles();
      byId("debug").checked = value.debug;
      updatePrecisionPreview();
      updateScopePreview();
      updateVpnStatus();
    };
    fillForm(settings);

    const close = () => host.remove();
    byId("cancel").addEventListener("click", close);
    for (const id of [
      "enabled", "siteMode", "sitePatterns", "timezoneEnabled", "localeEnabled", "workerEnabled",
    ]) {
      byId(id).addEventListener("input", updateScopePreview);
      byId(id).addEventListener("change", updateScopePreview);
    }
    for (const id of ["latitude", "longitude", "approximateEnabled", "approximateRadius"]) {
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
          ([result.city, result.country].filter(Boolean).join(", ") || result.ip) +
          "；即将刷新页面。";
        updateVpnStatus();
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        const network = readNetworkState();
        network.lastError = String(error && error.message || error).slice(0, 500);
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
    for (const id of ["latitude", "longitude"]) {
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
      const patterns = byId("sitePatterns").value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const exists = patterns.some((value) => value.toLowerCase() === rule.toLowerCase());
      if (!exists) {
        patterns.push(rule);
        byId("sitePatterns").value = patterns.join("\n");
      }
      updateScopePreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = exists
        ? "当前网站规则已存在：" + rule
        : "已添加当前网站：" + rule + "。应用模式未改变，保存并刷新后生效。";
    });
    byId("loadProfile").addEventListener("click", () => {
      const profile = workingProfiles[Number(byId("profileSelect").value)];
      if (!profile) {
        byId("error").textContent = "请先选择配置档。";
        return;
      }
      byId("latitude").value = String(profile.latitude);
      byId("longitude").value = String(profile.longitude);
      byId("accuracy").value = String(profile.accuracy);
      byId("language").value = profile.language;
      byId("languages").value = profile.languages.join(", ");
      byId("timezone").value = profile.timezone;
      byId("profileName").value = profile.name;
      updatePrecisionPreview();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已载入“" + profile.name + "”，点击保存并刷新后生效。";
    });
    byId("saveProfile").addEventListener("click", () => {
      const name = byId("profileName").value.trim();
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
      const existing = workingProfiles.findIndex((item) => item.name === profile.name);
      if (existing === -1) workingProfiles.push(profile);
      else workingProfiles[existing] = profile;
      renderProfiles();
      byId("profileSelect").value = String(existing === -1 ? workingProfiles.length - 1 : existing);
      byId("error").style.color = "#86efac";
      byId("error").textContent = "配置档已加入表单，请点击保存并刷新以写入存储。";
    });
    byId("deleteProfile").addEventListener("click", () => {
      const index = Number(byId("profileSelect").value);
      if (!workingProfiles[index]) {
        byId("error").textContent = "请先选择配置档。";
        return;
      }
      const removed = workingProfiles.splice(index, 1)[0];
      renderProfiles();
      byId("error").style.color = "#86efac";
      byId("error").textContent = "已从表单删除“" + removed.name + "”，保存并刷新后生效。";
    });
    byId("exportConfig").addEventListener("click", async () => {
      const exported = JSON.stringify({
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
        const parsed = JSON.parse(byId("configText").value);
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
      const latitude = Number(byId("latitude").value);
      const longitude = Number(byId("longitude").value);
      const accuracy = Number(byId("accuracy").value);
      const approximateRadius = Number(byId("approximateRadius").value);
      const language = byId("language").value.trim();
      const languages = byId("languages").value.split(/[,，\s]+/).filter(Boolean);
      const timezone = byId("timezone").value.trim();
      const siteMode = byId("siteMode").value;
      const sitePatterns = byId("sitePatterns").value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        byId("error").textContent = "纬度必须在 -90 到 90 之间。";
        return;
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        byId("error").textContent = "经度必须在 -180 到 180 之间。";
        return;
      }
      if (!Number.isFinite(accuracy) || accuracy < 1 || accuracy > 100000) {
        byId("error").textContent = "定位精度必须在 1 到 100000 米之间。";
        return;
      }
      if (!Number.isFinite(approximateRadius) ||
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
      const invalidPatterns = sitePatterns.filter((value) => !parseSitePattern(value));
      if (invalidPatterns.length) {
        byId("error").textContent = "网站规则无效：" + invalidPatterns.join("、");
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
        vpnCheckMinutes: Number(byId("vpnCheckMinutes").value),
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
      Object.assign(host.style, {
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
      Object.assign(host.style, {
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

  patchWindow(window);
  installIframeCoverage();
  registerMenus();
  installAutoVpnSync();
  installFloatingButton();
  installOnboarding();
  log("Installed", { version: VERSION, enabled: settings.enabled });
})();
