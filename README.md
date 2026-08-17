# 1688 商品主图 + 详情页采图插件(DSH)

> ⚠️ **重要:本插件需要配合浏览器插件([1688 Cookie 助手](#2-安装浏览器插件))一起安装使用。**
> 插件本身负责抓取和下载,浏览器插件用于一键发送你的 1688 登录 Cookie(规避风控),两者缺一不可。

在 **DeepSeek Harness (DSH)** Web 界面中批量采集 1688 商品的主图和详情页图片,按商品 ID 分别保存到「主图」「详情页」两个文件夹。

```
<保存目录>/
└── <商品ID>/
    ├── 主图/0001.jpg 0002.jpg ...    ← 商品主图
    └── 详情页/0001.jpg 0002.jpg ...  ← 商品详情页长图
```

## 功能

- **批量采集**:一次粘贴多个 1688 商品链接(`detail.1688.com/offer/<id>.html`),自动按行解析
- **主图 + 详情页**:通过 1688 MTOP 接口(miniod)获取商品全量数据,主图直接下载,详情页从 itemcdn 详情页提取图片
- **自动文件夹结构**:按商品 ID 分目录,内含 `主图/` 与 `详情页/` 两个子文件夹
- **Cookie 一键获取**:浏览器插件点一下图标,自动把登录 Cookie 发送到 DSH,遇到风控也能稳定抓取;Cookie 持久化保存,重启 DSH 不丢失
- **并发下载**:可调节并发数,批量下载更快
- **任务进度**:实时显示每个商品的主图/详情页下载数量

## 目录结构

```
1688-grabber/
├── dsh-plugin/
│   ├── host-1688-grabber/          # DSH Host 插件(抓取 + 下载)
│   └── client-ui-1688-grabber/     # DSH Client 插件(侧边栏 UI)
└── browser-extension/              # 360/Chrome/Edge 浏览器插件(Cookie 助手)
```

---

## 安装

### 1. 安装 DSH 插件

将 `dsh-plugin/` 下两个插件包放入 DSH 仓库的对应位置:

| 包 | 放入目录 |
|---|---|
| `host-1688-grabber` | `packages/host/1688-grabber` |
| `client-ui-1688-grabber` | `packages/client/ui-1688-grabber` |

同时在 DSH 仓库中完成以下装配(如果你是从源码构建 DSH):

- `packages/api/remotes/src/client/index.ts` — 注册 `grab1688` Remote 贡献:
  ```ts
  import grab1688Remote from '@deepseek-ai/dsh-host-1688-grabber/remote'
  // 在 apply() 的 contribution 数组中加入 grab1688Remote
  ```
- `packages/bundle/web-app/cordis.patch.yml` — 名册挂载:
  ```yaml
  # host 服务
  - id: grab1688
    name: '@deepseek-ai/dsh-host-1688-grabber'
  # client 插件
  - id: ui-1688-grabber
    name: '@deepseek-ai/dsh-client-ui-1688-grabber'
  ```
- `packages/bundle/web-app/package.json` — 添加两个 workspace 依赖

然后构建并重启 DSH:

```sh
pnpm install
pnpm run build:lib:host
pnpm run build:lib:client
pnpm run build:web
```

### 2. 安装浏览器插件

> ⚠️ **必须先安装浏览器插件**,否则抓取遇到 1688 风控时无法发送 Cookie。

以 **360 极速浏览器**(Chrome/Edge 同理,Chromium 内核)为例:

1. 打开浏览器,地址栏输入 `360chromeg://extensions`(Chrome 用 `chrome://extensions`,Edge 用 `edge://extensions`)回车
2. 右上角打开 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**,选择本仓库的 `browser-extension/` 文件夹
4. 工具栏出现橙色 **「1688 Cookie 助手」** 图标,安装完成

> 扩展只读取 1688.com 的 Cookie 并发送到你本机的 DSH(`127.0.0.1:3080`),不会上传到任何外部服务器。

---

## 使用

1. 打开 DSH Web 界面,左侧边栏底部点击 **「1688 采图」**
2. 粘贴商品链接(每行一个),例如:
   ```
   https://detail.1688.com/offer/1234567890.html
   https://detail.1688.com/offer/0987654321.html
   ```
3. 点击 **「选择文件夹…」** 选择保存目录
4. 首次使用(或 Cookie 过期时):点击 **「前往浏览器插件发送 Cookie」**,在弹出的 1688 页面点浏览器工具栏的 **1688 Cookie 助手图标 → 一键发送 Cookie**,回到面板后状态显示「已从浏览器获取 Cookie ✓」
5. 点击 **「开始抓取」**,实时查看每个商品的主图/详情页下载进度
6. 完成后点击 **「打开目录」** 直达保存位置

## 常见问题

| 问题 | 解决 |
|---|---|
| 抓取报风控/验证码错误 | 先在 360 浏览器登录 1688.com,再点扩展图标发送 Cookie |
| 浏览器插件按钮点了没反应 | 确认 DSH 正在运行(端口 3080),且扩展已加载 |
| 抓取显示「商品信息不存在」 | 商品可能已下架或链接有误 |
| 详情页没有图片 | 部分商品详情为空或仅文本,属正常现象 |

## 隐私说明

- 浏览器插件读取的 Cookie 仅发送到本机 DSH(`127.0.0.1:3080`),并保存到 `~/.dsh/grab1688-cookie.json`,不会上传任何第三方服务器
- 请勿把 Cookie 分享给他人

## License

MIT
