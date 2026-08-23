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
- Date、Intl、IANA 时区及可选语言一致性。
- 同源 iframe、Blob/Data/Module Worker，以及可选的实验性 URL Worker。
- 城市搜索、坐标到时区解析、地点配置档。
- VPN 公网出口一键同步，以及页面运行期间的可选自动检查。
- 所有网站、允许列表、排除列表三种应用范围。
- Via 菜单、移动设置面板、配置导入导出及可选浮动入口。

## 重要限制

- Via 无法同步修改 HTTP `Accept-Language`，因此语言功能默认关闭并属于实验性功能。
- 跨域 iframe 和 Service Worker 无法覆盖，URL Worker 为实验性功能。
- Via 没有扩展后台任务；VPN 自动同步只在至少一个网页标签运行时工作。
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
- 本项目没有自己的上报服务器；项目自身只在 Via 的脚本存储中持久化设置和缓存。

## 来源与许可

定位对象模型与反检测技术改编自 Anthony Sgro 的 MIT 许可项目 [GeoSpoof](https://github.com/anthonysgro/geospoof)。GeoSpoof 名称及 Logo 不在 MIT 授权范围内，本项目未使用其品牌标识。

项目代码采用 MIT 许可证，见 [LICENSE](LICENSE)。上游完整版权及许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，并已同时嵌入独立分发的用户脚本。

城市搜索使用 [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)，位置数据基于 [GeoNames](https://www.geonames.org/)。这些网络服务及数据不因本项目采用 MIT 而改变其各自的使用条款和许可。
