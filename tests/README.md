# 浏览器回归

环境：Node.js 20+、Playwright（本次使用 1.62.1）和支持 Temporal 的 Chromium。测试只访问本地 HTTP fixture，不使用真实账户或定位服务。

```sh
npm install --no-save playwright@1.62.1
npx playwright install chromium
node tests/browser-regressions.cjs
node tests/date-and-realms.cjs
node tests/review-regressions.cjs
node tests/hardening-regressions.cjs
```

可设置 `BROWSER_PATH` 使用已有 Chromium/Edge 可执行文件；已有 Playwright 安装也可以通过 `NODE_PATH` 引入。日期对照需要完整 Git 克隆中保留 v1.0.4 提交 `c8c25c0`。

## v1.0.7 验证结果

实际浏览器：Edge 157.0.4341.46。`hardening-regressions.cjs` 新增 32/32 组通过；既有三套分别为 24/24、15/15、34/34。语法检查和 `git diff --check` 通过。

- 16 组 Trusted Types 组合：开启 URL Worker 实验选项，Worker/SharedWorker × URL/Blob × `{}`、`{type:'classic'}`、`{name:'x'}`、`{type:'module'}`；同时检查构造器子类和实际脚本运行。
- 4 组 getter 边界：Worker 和 SharedWorker 的成功 getter 在回退时各执行两次；getter 抛出与 Trusted Types 错误消息相同的 TypeError 时仍只执行一次，并保留异常对象身份。
- 12 组观察器挂钩：主页面和 iframe 各自安装后替换构造器、三个方法及 `addedNodes` getter；测试记录调用并返回伪造记录，以及逐个入口抛错。HTML 插入、5000 次 innerHTML 循环和异步记录处理完成后，五个挂钩计数均为 0，无页面异常，新增 iframe 即时读取仍为伪装时区。
- 同一套 32 组在原始 v1.0.6（`f2315c1`）上有 30 组失败、2 组通过，分别复现带选项的 Trusted Types 回退和观察器可被网页替换的问题。

保存的观察器引用以每个 realm 为单位，防止安装**之后**的网页替换；这不代表能恢复安装之前已经被替换的原生函数，也不宣称消除了所有脚本检测渠道。Trusted Types 回退仍使用原生 Worker 环境，且可能重复读取成功的选项 getter。Via/Android 真机尚未验证。

## v1.0.6 验证结果

实际浏览器：Edge 157.0.4341.46。新增 `review-regressions.cjs` 15 组全部通过，既有两套测试分别 24/24、34/34 通过。

- 强制 `require-trusted-types-for 'script'`：Worker/SharedWorker、URL 实验开关关闭/开启、可信 Blob URL、SharedWorker 重复连接、构造器子类；不可信字符串仍被拒绝，不创建宽松 policy。页面选项 getter 抛出的 TypeError 不重试。
- `Temporal.Instant#toLocaleString`：主页面、嵌套 iframe、Worker、SharedWorker；默认/显式时区、关闭/排除、继承选项、冻结的 `timeZone: undefined`、getter 单次调用、参数错误、页面异常身份和函数外观。
- DocumentFragment、多 iframe、移动/重新插入、TrustedHTML 的四种插入位置保持同步。调用计数断言确认追加普通节点不扫描旧文档、也不读取已有 iframe。相同场景下 v1.0.5 有 2600 次旧文档查询、26000 次已有 iframe 读取，修复后均为 0。
- 使用 `VLM_SOURCE` 指向提交 `9253b5b` 的 v1.0.5 脚本，新增 15 组有 9 组失败，覆盖本次三项报告；修复后 15/15 通过。

性能基准：初始约 22000 个元素（11000 个 `<div><i></i></div>`），另加 0/10/40 个 iframe；每格为三个新建页面测量的中位数，单位 ms。仅计同步 DOM 调用耗时，不计脚本初始化、布局绘制或后续微任务；短时测量会受 JIT 和系统调度影响，不代表手机实测。

| iframe 数 | 版本 | appendChild × 2000 | insertAdjacentHTML × 200 | append 文本 × 200 |
| --- | --- | ---: | ---: | ---: |
| 0 | 无脚本 | 0.7 | 0.5 | <0.1 |
| 0 | v1.0.5 | 108.4 | 24.5 | 11.2 |
| 0 | v1.0.6 | 3.9 | 1.6 | 0.3 |
| 10 | 无脚本 | 0.7 | 0.6 | <0.1 |
| 10 | v1.0.5 | 123.1 | 25.7 | 12.7 |
| 10 | v1.0.6 | 1.6 | 1.2 | 0.5 |
| 40 | 无脚本 | 0.6 | 0.6 | 0.1 |
| 40 | v1.0.5 | 169.9 | 35.0 | 16.5 |
| 40 | v1.0.6 | 5.3 | 1.8 | 0.2 |

`review-regressions.cjs` 默认包含性能基准，需要 Git 历史中的 v1.0.5 提交 `9253b5b`；设置 `VLM_SKIP_BENCH=1` 可只跑功能与调用计数断言。基准不以易波动的毫秒阈值决定测试成败。

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
