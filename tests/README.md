# 浏览器回归

环境：Node.js 20+、Playwright（本次使用 1.62.1）和支持 Temporal 的 Chromium。测试只访问本地 HTTP fixture，不使用真实账户或定位服务。

```sh
npm install --no-save playwright@1.62.1
npx playwright install chromium
node tests/browser-regressions.cjs
node tests/date-and-realms.cjs
```

可设置 `BROWSER_PATH` 使用已有 Chromium/Edge 可执行文件；已有 Playwright 安装也可以通过 `NODE_PATH` 引入。日期对照需要完整 Git 克隆中保留 v1.0.4 提交 `c8c25c0`。

## v1.0.5 验证结果

实际浏览器：Edge 157.0.4341.46。原生时区设置为 America/New_York，伪装为 Asia/Tokyo。

- `browser-regressions.cjs`：24 组，覆盖 Temporal 五个方法及显式参数/关闭/排除、不提供 API 的环境、15 种 DOM 插入路径、三层 iframe、导航与 document.write、随机数调用观察、具名与匿名注入的定位错误堆栈、页面异常保持、Worker/SharedWorker 的 Blob/Data/URL × classic/module、URL 模块依赖加载顺序、SharedWorker 名称重载与连接复用、构造器子类。
- `date-and-realms.cjs`：34 组，覆盖独立注入、父子与兄弟 iframe 的函数外观、重复注入、SPA、导航、跨源中间层下的同源叶节点、恶意 getter/Proxy、权限事件，以及 20 个时区 × 29 个日期相对 v1.0.4 的行为一致性。
- 将 `VLM_SOURCE` 指向原始 v1.0.4 后，最初 22 组 API 测试有 17 组失败，可检出本次报告的六类问题；同一测试集在修复后通过。后续追加匿名错误堆栈和 API 缺失两组。
- `node --check via-location-mask.user.js`、`git diff --check`。

## 原生日期一致性审计（已知差异）

```sh
node tests/date-and-realms.cjs --native-dates
```

这个显式审计把日期结果与浏览器真实运行在目标时区时的原生结果比较，**不是**与 v1.0.4 比较。目前在 Edge 157 上有 20 个失败组（含 Worker 日期组）：历史秒级偏移被取整为分钟，以及部分地区/历史日期的时区名称不同，例如 Casablanca、Almaty、Windhoek。v1.0.4 与本次版本在这些日期上的结果一致；本次六项修复没有调整已有 Date 算法，也不把基线一致性测试称为原生一致性通过。

## 验证边界

- 未做 Via/Android 真机回归。没有 Temporal/SharedWorker 的环境只确认特性检测能正常跳过；不能据桌面结果推断每个 WebView 版本的支持情况。
- iframe 插入方法返回后同步覆盖，不承诺覆盖解析器或插入内部先行执行的脚本，也不覆盖跨源 frame。
- SharedWorker 的 URL 缓存由同一个注入实例管理；跨标签页/独立注入实例共享身份不保证。URL Worker 仍为实验性支持，受 CSP、相对模块路径和 worker location 等限制。
- 错误堆栈修复针对定位原生参数校验异常的 `.stack`，依赖 Via 所用 V8 的 `Error.captureStackTrace`；不改写全局错误事件的 filename，也不宣称消除了所有 API 的检测特征。
