# Via Location Mask

适用于 Via Browser 的非官方用户脚本。它可以按网站修改网页 JavaScript 读取到的定位、时区和可选语言信息，并支持稳定近似位置、城市搜索、地点配置档及 VPN 出口同步。

本项目与 Via Browser 或 GeoSpoof 无隶属、认可或合作关系。它不会修改 Android 系统 GPS、系统语言、公网 IP，也不会连接或切换 VPN。

https://raw.githubusercontent.com/KestrelFeather/via-location-mask/main/via-location-mask.user.js

## 安装

1. 下载并在 Via 中打开 `via-location-mask.user.js`。
2. 如果没有自动出现安装提示，进入“设置 → 脚本 → 添加脚本”，粘贴脚本全文。
3. 从 Via 脚本菜单打开“设置 Via Location Mask”。
4. 填写坐标或搜索城市，选择网站范围及需要的功能，然后启用总开关并保存刷新。

## 主要功能

- `getCurrentPosition`、`watchPosition`、`clearWatch` 与定位权限状态。
- 稳定的近似位置和坐标精度设置。
- Date、Intl、Temporal.Now、Temporal.Instant 格式化、IANA 时区及可选语言一致性。
- 递归同源 iframe、Blob/Data/Module Worker 与 SharedWorker，以及可选的实验性 URL Worker。
- 城市搜索、坐标到时区解析、地点配置档。
- VPN 公网出口一键同步，以及页面运行期间的可选自动检查。
- 所有网站、允许列表、排除列表三种应用范围。
- Via 菜单、移动设置面板、配置导入导出及可选浮动入口。

## 重要限制

- Via 无法同步修改 HTTP `Accept-Language`，因此语言功能默认关闭并属于实验性功能。
- 跨域 iframe 和 Service Worker 无法覆盖，URL Worker 为实验性功能。
- Temporal、SharedWorker 仅在浏览器原生提供时包装，不会为不支持的 WebView 添加 API。同一注入实例管理的 SharedWorker 连接复用替换后的 URL；不同标签页或独立注入实例之间的共享身份无法保证。
- iframe 的同步覆盖发生在 DOM 插入方法返回前；不保证覆盖 HTML 解析器或插入过程中已经执行的子页面脚本。MutationObserver 和 load 监听继续作为补充。
- 强制 Trusted Types 的页面拒绝补丁 Blob URL 时，会用页面原始参数创建 Worker，以保留网站功能；该 Worker 使用原生环境，不保证时区/语言伪装。脚本不会创建宽松的 Trusted Types policy。
- Via 没有扩展后台任务；VPN 自动同步只在至少一个网页标签运行时工作。
- 页面运行中更新时区和语言后，Date 和新建 Intl 对象会使用当前设置；已有 Intl 实例及已启动的 Worker 保留创建时的设置，刷新页面可统一更新。
- Via 原生设置已禁用 WebRTC，本项目不实现 WebRTC 包装。
- “保留网站原生定位权限提示”一般应保持关闭；启用后会真实触发 Via/Android 的网站定位授权，拒绝或撤销权限可能返回 `GeolocationPositionError`。
- 页面脚本层的修改仍可能被高级指纹检测识别，不能视为匿名工具或 VPN 的替代品。
- 定位伪装可能违反部分网站的服务条款，请自行确认并负责任地使用。

## 网络请求与隐私

网络功能均由用户主动使用，VPN 自动检查默认关闭：

- 城市搜索会把搜索词发送给 Open-Meteo Geocoding API，结果缓存 7 天。城市数据基于 GeoNames，并按 CC BY 4.0 提供。
- Open-Meteo 免费开放接口仅允许非商业使用；商业使用者必须改用其商业接口或其他合规服务。
- 手动坐标反查时区会把坐标发送给 TimeAPI.io，结果缓存 30 天。
- VPN 同步可能依次联系一个或多个公网 IP 服务（ipify、ident.me、ifconfig.me、icanhazip），成功后停止。
- 随后可能依次把该 IP 发送给一个或多个 IP 地理服务（FreeIPAPI、GeoJS、ReallyFreeGeoIP、ipinfo），成功后停止；结果缓存 30 天。
- 第三方服务会收到正常网络连接附带的来源 IP，并处理相应查询词、坐标或待查询 IP。请同时查看各服务自己的条款与隐私政策。
- 本项目没有自己的上报服务器；项目自身只在 Via 的脚本存储中持久化设置、缓存，以及用于识别重复注入的最近 200 个页面标记（网址与加载时间的哈希值，不保存网址本身）。

## v1.0.6 修复

- 修复 v1.0.5 的 Trusted Types 回归：Worker/SharedWorker 的原样创建分支保留原始 `TrustedScriptURL` 及参数；生成的补丁 URL 被原生 Trusted Types 校验拒绝时，退回原始参数创建。页面选项 getter 抛出的错误不触发重试。
- 修复同步 iframe 拦截的 DOM 性能回归：节点类接口只收集插入节点中的 iframe，DocumentFragment 在插入前收集；HTML 类接口及 `document.write/writeln` 同步读取本次操作的 mutation records，只处理新增内容。异步观察器跳过已处理 iframe，移动/重新插入和 load 事件仍会检查新页面。
- 补齐主页面、同源 iframe、Worker 和 SharedWorker 的 `Temporal.Instant.prototype.toLocaleString()`：省略 `timeZone` 时使用伪装时区；保留显式时区、继承/冻结选项、getter 调用顺序及原生参数错误。

Edge 157.0.4341.46：新增 15 组回归、既有 24 组 API 回归和 34 组日期基线/realm 回归全部通过。约 2.2 万节点的同机基准中，追加 2000 个节点从 v1.0.5 的约 108–170 ms 降至约 1.6–5.3 ms；具体测试条件及结果见 [测试说明](tests/README.md)。尚未在 Via/Android 真机验证。

## v1.0.5 修复

- 补齐 `Temporal.Now.timeZoneId`、`plainDateTimeISO`、`plainDateISO`、`plainTimeISO`、`zonedDateTimeISO`；主页面、同源 iframe 和 Worker 共用实现，显式时区参数及关闭/排除状态保持原生语义。
- 同时包装 `Worker` 和 `SharedWorker`，覆盖 Blob、Data 及模块脚本；保留 SharedWorker 字符串名称重载、同 URL 重复连接和构造器子类行为。实验性 URL 模块 Worker 先执行时区补丁模块，再执行原始模块及其依赖。
- 同步拦截 `appendChild`、`insertBefore`、`replaceChild`、`append`、`prepend`、`replaceChildren`、`before`、`after`、`replaceWith`、`insertAdjacentElement`、`insertAdjacentHTML`、`innerHTML`、`outerHTML` 和 `document.write/writeln`，解决插入后立即从 `frames[n]` 读取的窗口；每层同源 iframe 都递归安装拦截。
- 定位随机数改用启动时绑定的 `crypto.getRandomValues` 和预分配缓冲区，不再调用网页的 `Math.random`，也不消耗其伪随机序列。
- 原生定位参数校验错误在向页面抛出前移除脚本调用帧，保留错误类型、消息和页面调用位置；支持没有 sourceURL 的 Via 注入。页面选项 getter 自己抛出的异常保持不变。补齐无参数 `clearWatch()` 的原生错误。

本次在 Edge 157.0.4341.46 验证了新增 API 回归，以及既有 iframe/重复注入行为和 20 个时区相对 v1.0.4 的日期行为。可复现命令、覆盖范围及已知原生日期差异见 [测试说明](tests/README.md)。尚未在 Via/Android 真机验证。

## v1.0.4 修复

- iframe 的环境已被父页面处理、随后又独立注入脚本时，iframe 后续创建的访问器（如 `contentWindow` getter）会暴露源码。现在该实例会在父页面的伪装之上再加一层伪装，由这一层识别自己的包装函数，其余请求仍交给父页面。
- 同源兄弟 iframe 各自独立注入时，会互相暴露 Date 等包装函数的源码。现在伪装遇到陌生页面的函数时，会从 `top` 遍历整棵 frame 树（包括跨源中间页下的同源页面）来识别这些页面。遍历只使用启动时截获的原生 `length` getter 和不可挂钩的索引访问，并通过属性描述符核对原生 `Function`，因此不会触发网页设置的 getter 或 Proxy。

## v1.0.3 修复

- 移除 v1.0.2 的令牌共享状态：网页包装 `Function.prototype.toString` 后，同一文档再次注入时可截获令牌和完整补丁状态。各注入实例现在不再交换任何对象，也不会向网页可包装的函数传递秘密。
- 同一文档的重复注入改由脚本存储中的页面标记识别；标记不可用时，第二个实例叠加的补丁外观仍保持一致。
- 修复同源子页面先于父页面注入时，两边互相暴露包装函数源码的问题。伪装的 `toString` 遇到其他实例的包装函数时，会交给该函数所属页面的伪装回答；转交前先用原生 `toString` 核对对方确实是本脚本的伪装，因此不会调用网页函数，也不会触发网页设置的 Proxy。

## v1.0.2 修复

- 移除 v1.0.1 挂在页面 `document` 上的公开 `Symbol.for` 标记。（v1.0.2 改用的令牌共享状态机制存在截获问题，已在 v1.0.3 移除，见上。）
- 伪装的定位权限对象不再带有自有属性；`state`、`name`、`onchange` 改由原型访问器提供，外观与原生一致。
- 修复公元前年份的显示（如 `-0001`），以及 `setYear` 和 `new Date(y, m)` 对小数两位数年份的处理。
- `Date#toString` 的时区名称改用与 V8 相同的规则（当前标准/夏令时名称），历史日期不再显示为 `GMT+09:18:59`。
- 本地时间字符串恰好落在真实时区夏令时空档内时，解析结果不再偏差 1 小时。
- 修复 Worker 中的 `toDateString`、`toTimeString` 未被伪装的问题；Worker 与主页面改用同一套时区实现。
- 同一全局对象换页后不再重复包装 Worker 等 API；降低 `navigator.languages` 和日期取值的开销。

桌面 Chromium 回归对 10 个时区（含历史 LMT、公元前日期、夏令时空档）逐项对照原生结果，主页面与 Worker 共 900 项全部一致。

## v1.0.1 修复

- 修复 VPN 自动同步后的 Date/Intl 时区不一致，以及 `navigator.languages` 沿用旧设置。
- 修复定位权限对象的事件监听、移除监听及 `onchange`；定位监听回调抛出异常后继续推送。
- 修复 iframe 导航后的函数外观和 Worker 补丁失效，同源父子页面独立注入时共享补丁记录，防止重复包装。
- 修复无效日期字符串、无效日期的 `setFullYear`/`setYear`、ISO 仅日期字符串、带时区缩写字符串，以及年份 0–99 和历史秒级时区偏移。
- 修复负零度分秒坐标、内网单段主机名和 IPv6 网站规则。
- 修复 `maximumAge: Infinity` 的缓存处理，并保持 Intl 构造器原有的普通调用、`new` 和子类行为。

桌面 Chromium 回归覆盖主页面、同源 iframe、Blob/Data/Module Blob/URL Worker，并与浏览器原生的东京、纽约、柏林和 Kiritimati 时区结果对照。Via/Android 真机仍需复测；桌面通过不代表所有 WebView 版本均已验证。

## 来源与许可

定位对象模型与反检测技术改编自 Anthony Sgro 的 MIT 许可项目 [GeoSpoof](https://github.com/anthonysgro/geospoof)。GeoSpoof 名称及 Logo 不在 MIT 授权范围内，本项目未使用其品牌标识。

项目代码采用 MIT 许可证，见 [LICENSE](LICENSE)。上游完整版权及许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，并已同时嵌入独立分发的用户脚本。

城市搜索使用 [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)，位置数据基于 [GeoNames](https://www.geonames.org/)。这些网络服务及数据不因本项目采用 MIT 而改变其各自的使用条款和许可。
