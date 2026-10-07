# LAN-Drop-Chat

LAN-Drop-Chat 是一个面向局域网、多设备之间即时互传的小型 Web 工具。

它把“发一句话”“传一个文件”“贴一张截图”统一放进同一条聊天流里，尽量减少状态和配置成本。服务端部署在 NAS 或任意常开设备上后，手机、平板、电脑都可以直接通过浏览器访问。

## 特性

- 文本消息即时同步，卡片上标明来自哪台设备（iPhone / iPad / Mac / Windows / Android…）
- 内容识别：网址、邮箱、电话、卡密、验证码、IP，以及“账号 / 密码 / 取件码：值”会被高亮，点一下单独复制，网址可直接打开
- 新收到的内容会高亮，复制 / 下载按钮放在最顺手的位置
- “粘贴发送”：一键把剪贴板里的文字或截图发出去
- 单文件上传、多张图片自动合并为图片组，进度直接显示在卡片上，可取消、可重试
- 图片 / 视频预览，站内看图支持左右滑动切换、下滑关闭
- 桌面端全局拖拽上传，粘贴截图或文件直接发送
- 文本收藏，适合保存网址、手机号、邮箱、地址等常用内容
- 搜索与类型筛选（⌘K）
- 删除可撤销；清空聊天记录、清理物理文件放在设置里并二次确认
- 后台标签页显示未读数，可添加到 iPhone / iPad 主屏幕
- 手机、iPad、桌面三种布局，日间 / 夜间 / 跟随系统，五种主色可选

## 使用场景

- 手机和电脑之间快速传一段文本
- 把截图、参考图、短视频临时丢到局域网页面里
- 在多个设备之间共享常用链接和信息
- 在家用 NAS 上部署一个轻量、低门槛的“局域网中转站”

## 技术栈

- Node.js
- Express
- Socket.io
- SQLite3
- 原生 HTML / CSS / JavaScript

## 快速开始

### 本地运行

```bash
npm install
npm start
```

默认地址：

```text
http://localhost:3000
```

### Docker 运行（源码构建）

```bash
docker compose up -d --build
```

默认会挂载：

- `./data`：SQLite 数据库
- `./uploads`：上传文件目录

## 数据行为

- 聊天记录保存在 `data/chat.db`
- 上传文件保存在 `uploads/`
- 多图消息会作为一条图片组消息保存，并保留组内顺序
- “清空聊天记录”只删除消息历史，不删除上传文件，也不会影响收藏夹
- “清理物理文件”会清空上传目录，并把对应文件消息替换成系统提示
- 每条消息会记录发送设备类型；升级前的旧消息没有这项信息，会先显示 IP

## 更新说明

最新更新见 [CHANGELOG.md](CHANGELOG.md)。

## 部署说明

这个项目适合部署在任何支持 Docker 的设备上，例如：

- 群晖 / 威联通 / 极空间 / TrueNAS 等 NAS
- 家用 Linux 小主机
- 常开的局域网服务器
- 任意可以运行 Docker / Container Manager 的设备

只要浏览器能访问服务地址，就可以直接使用，不需要安装客户端。

### 一键部署（推荐）

如果目标设备已经安装了 Docker 或容器管理器（如 Container Manager），可以直接使用下面这份 `docker-compose.yml`。

这种方式不需要额外安装 Node.js、npm 或拉取源码，复制 YML 后即可部署：

```yaml
services:
  lan-drop-chat:
    image: ghcr.io/jtfgu233/lan-drop-chat:latest
    container_name: lan-drop-chat
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    restart: unless-stopped
```

然后在同目录执行：

```bash
docker compose up -d
```

部署完成后，通过下面地址访问：

```text
http://你的NAS或服务器IP:3000
```

如果你的设备界面支持通过 YML / Compose 直接创建项目，把上面的内容粘贴进去即可。

### 添加到主屏幕

在 iPhone / iPad 的 Safari 里打开服务地址，点「分享 → 添加到主屏幕」，之后就能像 App 一样从主屏幕全屏打开。

> 通过局域网 http 地址访问时，浏览器不允许网页直接读取剪贴板。此时点「粘贴发送」会提示你粘贴，粘贴后自动发出。

换句话说：

- 如果设备已经能运行 Docker，那么只拿这一份 YML 就可以部署
- 如果设备还没有安装 Docker，那么需要先安装 Docker，再使用这份 YML

## 开源许可

本项目使用 [MIT License](LICENSE)。
