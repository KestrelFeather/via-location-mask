# 浏览器回归

环境：Node.js 20+、Playwright（本次使用 1.62.1）和支持 Temporal 的 Chromium。测试只访问本地 HTTP fixture，不使用真实账户或定位服务。

```sh
npm install --no-save playwright@1.62.1
npx playwright install chromium
node tests/browser-regressions.cjs
node tests/date-and-realms.cjs
node tests/review-regressions.cjs
node tests/hardening-regressions.cjs
node tests/intrinsic-regressions.cjs
node tests/locale-options-regressions.cjs
node tests/locale-cache-regressions.cjs
node tests/stack-regressions.cjs
```

可设置 `BROWSER_PATH` 使用已有 Chromium/Edge 可执行文件；已有 Playwright 安装也可以通过 `NODE_PATH` 引入。日期对照需要完整 Git 克隆中保留 v1.0.4 提交 `c8c25c0`。

## v1.0.11 验证结果

实际浏览器：Edge 157.0.4341.46。`stack-regressions.cjs` 16/16；原有七套分别 8/8、4/4、3/3、24/24、15/15、32/32、34/34，共 136 组通过。语法检查及 `git diff --check` 通过。本轮 review 套件使用 `VLM_SKIP_BENCH=1`，保留 DOM 调用计数断言。

- 窗口和同源 iframe 各验证具名/匿名注入。每个窗口场景包含 23 个异常用例，覆盖本次报告的 8 个问题以及 Date/Intl/Temporal/语言方法、Function.toString、DOM、Worker/SharedWorker、Navigator getter 和定位参数错误。比较错误类型、消息及完整堆栈字符串，不只搜索内部函数名。
- Worker 与 SharedWorker 各比较 15 个可用 API 的异常。页面测试调用位于相同的具名 fixture，Worker 由异步消息触发，避免用归一化删掉真正的调用帧差异。
- 窗口和 iframe 分别测试 30 层页面调用链及 `Error.stackTraceLimit=0/1/2/20`。保留原生第一帧和正确的总帧数，iframe 的设置不会被顶层覆盖。
- 每个常规/深栈/Worker 场景还执行 40 个页面异常保持断言：预先创建的 Error、getter 内捕获的 JSON 原生异常、基本类型、Proxy 抛出值及自定义 stack getter。错误身份、已存在的堆栈和 getter/Proxy 调用情况保持不变；特意将页面抛错函数命名为 nativeApply，确保不会按名字误删。
- 两组自定义 `Error.prepareStackTrace` 验证：窗口/iframe 中不提前调用、不替换该函数，由页面读取 stack 时自行格式化。此路径保留页面行为，不执行标准字符串堆栈清理。
- `VLM_SOURCE` 指向 v1.0.10（`222abee`）时，同套 16 组有 13 组失败、3 组通过，能检出原有包装帧和缓存路径栈顶变化。

复跑 `VLM_BENCH=1` 的默认格式化基准：20000 次、三个新页面的中位耗时，原生三个方法依次为 14.3/9.6/9.5 ms，v1.0.11 为 15.5/11.3/11.3 ms（toLocaleString/toLocaleDateString/toLocaleTimeString）。构造次数断言继续通过，缓存优化未回退到逐次构造格式化器。毫秒测量不作为通过阈值，也不代表手机性能。

本次清理只处理在原生调用入口标记、且堆栈来源符合实际原生调用位置的同步异常。已被内部捕获的异常不读取 stack，页面主动抛出的异常不改写；自定义堆栈格式、全局错误事件 filename、异步 Promise 拒绝和已有日期算法差异不在逐帧一致性结论内。尚未做 Via/Android 真机验证。

## v1.0.10 验证结果

实际浏览器：Edge 157.0.4341.46。新增 `locale-cache-regressions.cjs` 3/3，扩展后的原生选项对照 4/4、内置函数回归 8/8，既有四套分别 24/24、15/15、32/32、34/34，共 120 组通过。语法检查及 `git diff --check` 通过；本轮 review 套件设置 `VLM_SKIP_BENCH=1`，保留 DOM 调用计数断言。

- 缓存确定性断言：三个方法各执行 2000 次，合计只创建三个原生 DateTimeFormat，不再进入 Date 的原生慢路径；显式 `undefined`/空对象/冻结 options 和 locales 数组仍进入原生路径。通过注入前的测试计数器验证构造次数，不依赖耗时阈值。
- 切换时区、语言、语言开关、时区开关及总开关后输出正确；40 种 locale 字符串触发容量淘汰，重新访问被淘汰项会重建且输出正确。测试用设置入口只存在于 fixture，不进入发布脚本。
- 原生格式化对照新增九种 locales（含默认语言、日历/数字/小时周期扩展）、七种时间值及无参数调用；检查缓存首次调用与命中、无效 Date/接收者、语言对象 getter 的逐次读取，以及 Date 自有 valueOf 不被调用。主页面、嵌套 iframe、Worker/SharedWorker 均与真实东京时区的原生结果一致。
- 内置函数回归新增默认格式化和缓存命中路径，页面在安装后替换相关内置入口时，计数及截获函数数仍为 0。
- `VLM_SOURCE` 指向 v1.0.9（`930d6cf`）时，缓存复用/容量两组失败，设置行为一组通过。

设置 `VLM_BENCH=1` 运行 `locale-cache-regressions.cjs` 可附加性能对照，需要 Git 历史中的 v1.0.9 提交 `930d6cf`。每格为三个新页面的中位耗时；先预热 200 次，再对同一个 `new Date(0)` 调用 20000 次，显式 locales 为 `'en-US'`，完全省略 options。原生页面时区为东京，脚本页面时区为纽约并伪装为东京；输出长度校验和相同。耗时仅作测量记录，不作为测试通过阈值。

| 方法（20000 次） | 原生 | v1.0.9 | v1.0.10 |
| --- | ---: | ---: | ---: |
| toLocaleString | 14.8 ms | 837.1 ms | 16.7 ms |
| toLocaleDateString | 10.1 ms | 862.6 ms | 11.8 ms |
| toLocaleTimeString | 10.3 ms | 848.9 ms | 11.8 ms |

缓存只在时区伪装生效时启用；设置变化在下次使用缓存前失效，Worker 仍保留启动时配置。未做 Via/Android 真机测试，已有历史 Date 算法差异保持不变。

## v1.0.9 验证结果

实际浏览器：Edge 157.0.4341.46。扩展后的 `intrinsic-regressions.cjs` 8/8、新增 `locale-options-regressions.cjs` 4/4；原有四套分别 24/24、15/15、32/32、34/34，总计 117 组通过。语法检查及 `git diff --check` 通过，本轮 review 套件设置 `VLM_SKIP_BENCH=1`，保留 DOM 调用计数断言，未重跑毫秒性能基准。

- 内置函数挂钩加入 `setTimeout`、`clearTimeout`、`queueMicrotask` 和 `Promise.resolve`，同时记录传入定时器/微任务的函数，检测内部回调泄漏。测试执行首次定位、缓存定位、监听的首次及第二次回调、取消监听、权限查询；记录模式和抛错模式均通过，所测入口调用计数与截获函数数均为 0。测试自己的超时计时使用挂钩前保存的入口，避免把测试调用计入脚本。
- 格式化对照以未注入脚本、真实时区为 Asia/Tokyo 的页面为基准，在 America/New_York 中注入东京伪装。主页面、嵌套 iframe、Worker、SharedWorker 分别比较 98 个用例，涉及 Date 三个 `toLocale*`、Intl.DateTimeFormat 的构造/普通调用、Temporal.Instant 格式化，以及 Date 非法接收者/无效日期。
- 选项覆盖继承属性、不可枚举属性、冻结的 undefined 时区、显式 UTC、undefined/null/基本类型、非法时区、不得读取的无关 getter、Proxy 读取轨迹、getter 的接收者/次数/顺序和页面异常对象身份。输出及上述可观测行为均与原生基准一致。
- `VLM_SOURCE` 指向 v1.0.8（`c1ab848`）时，同样的格式化对照 4 组全部失败，内置函数回归中的窗口观测/抛错 2 组失败；观测模式能截获监听续订的箭头函数源码。

上述原生对照只针对本次格式化选项语义，不改变下文已有的历史 Date 算法差异。快照防护仍以安装后替换为边界，未做 Via/Android 真机验证，也不代表消除了所有指纹路径。

## v1.0.8 验证结果

实际浏览器：Edge 157.0.4341.46。`intrinsic-regressions.cjs` 8/8 组通过；既有四套分别为 24/24、15/15、32/32、34/34，总计 113 组。日期套件默认仍是 v1.0.4 基线一致性，不表示历史原生日期差异已修复。

- 替换 `WeakMap.prototype.get = () => undefined` 后，Date 与 getCurrentPosition 的 `toString` 仍为原生外观。
- 将 Reflect、Object、WeakMap/WeakSet/Map/Set、Array、Function.bind、String/RegExp 的所测方法，以及 Array/Set/Map/NodeList 迭代器替换为计数函数或抛错函数。DOM 中还替换 NodeList.length getter。使用允许列表，覆盖规则解析而非只测默认全站模式。
- 执行日期取值、文本格式化、本地时间构造和 setter、Temporal.Instant 格式化、iframe 插入与嵌套、一次定位和一次监听，以及启动新 Worker。所测入口调用数均为 0；Reflect.apply 挂钩未截获任何内部实现函数。
- Worker 和 SharedWorker 中由被加载脚本安装同样的挂钩，日期、Temporal 和函数外观保持正确，调用数及截获数均为 0。
- 额外检查设置规范化、语言列表、网站规则去重和带方向字母的度分秒坐标解析。测试专用入口只加入浏览器 fixture，不写入分发脚本。
- `VLM_SOURCE` 指向原始 v1.0.7（`e0eefc4`）时，同一套新增测试为 1 组通过、7 组失败，检出函数源码泄漏与运行时挂钩。

按下文相同的大型 DOM 基准复核（三次中位数、0/10/40 个 iframe）：本版 appendChild × 2000 为 3.6/1.7/5.4 ms，insertAdjacentHTML × 200 为 1.5/1.3/4.3 ms，append 文本 × 200 为 0.3/0.1/0.2 ms。追加普通节点不扫描旧文档、也不读取已有 iframe 的调用计数断言继续通过。毫秒数据仅为桌面短时测量，不能代替手机实测。

该套件验证列出的 API 路径及挂钩集合，不等同于对所有网页内置对象、所有隐式协议或所有指纹探测的证明。原生引用必须在页面替换之前保存；Via/Android 真机尚未验证。

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
- 错误堆栈修复针对包装路径中已确认原生来源的同步异常 `.stack`，依赖 V8 的 `Error.captureStackTrace` 与标准字符串堆栈；不改写页面自定义 prepareStackTrace、异步 Promise 拒绝或全局错误事件的 filename，也不宣称消除了所有 API 的检测特征。
