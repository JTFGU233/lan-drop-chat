# LAN-Drop-Chat

LAN-Drop-Chat 是一个面向局域网、多设备之间即时互传的小型 Web 工具。

它把“发一句话”“传一个文件”“贴一张截图”统一放进同一条聊天流里，尽量减少状态和配置成本。服务端部署在 NAS 或任意常开设备上后，手机、平板、电脑都可以直接通过浏览器访问。

## 特性

- 文本消息即时同步
- 单文件上传并写入聊天流
- 图片 / 视频预览
- 剪贴板截图或文件粘贴上传
- 桌面端全局拖拽上传
- 文本收藏夹，适合保存网址、手机号、邮箱、地址等常用内容
- 一键清空聊天记录
- 一键清理物理文件
- 响应式界面，支持系统日间 / 夜间模式

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
- “清空聊天记录”只删除消息历史，不删除上传文件，也不会影响收藏夹
- “清理物理文件”会清空上传目录，并把对应文件消息替换成系统提示

## 部署说明

这个项目适合部署在任何支持 Docker 的设备上，例如：

- 群晖 / 威联通 / 极空间 / TrueNAS 等 NAS
- 家用 Linux 小主机
- 常开的局域网服务器
- 任意可以运行 Docker / Container Manager 的设备

只要浏览器能访问服务地址，就可以直接使用，不需要安装客户端。

### 一键部署（推荐）

如果你已经把镜像发布到 GHCR，可以直接使用下面这份 `docker-compose.yml`：

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

## 开源许可

本项目使用 [MIT License](LICENSE)。
