# LAN-Drop-Chat

一个面向局域网、多设备之间即时互传的小型 Web 工具。

后端基于 `Node.js + Express + Socket.io + SQLite3`，前端是单文件页面，支持文本消息、文件上传、图片/视频预览、剪贴板截图粘贴上传、拖拽上传、文本收藏夹、主题切换和历史清空。

## 功能概览

- 文本消息即时同步
- 文件上传并写入聊天流
- 图片 / 视频消息预览
- 剪贴板截图或文件粘贴上传
- 桌面端全局拖拽上传
- 文本消息收藏夹
- 一键清空聊天记录
- 一键清理物理文件
- 响应式 UI，支持系统日间 / 夜间模式

## 项目结构

```text
.
├── public/
│   └── index.html
├── data/
│   └── chat.db
├── uploads/
├── server.js
├── package.json
├── Dockerfile
└── docker-compose.yml
```

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

默认监听：

```text
http://localhost:3000
```

## 数据说明

SQLite 数据库位于：

```text
data/chat.db
```

当前包含两张表：

- `messages`
  - 聊天记录
- `favorites`
  - 文本收藏夹

程序启动时会自动创建缺失表结构，不需要手动初始化。

## 主要行为定义

### 清空聊天记录

- 仅删除 `messages`
- 不删除 `favorites`
- 不删除 `uploads/` 中的物理文件
- 会通过 Socket 广播 `history cleared`

### 清理物理文件

- 清空 `uploads/`
- 将已有文件消息更新为系统占位提示
- 会通过 Socket 广播 `system cleanup`

### 收藏夹

- 只允许收藏普通文本消息
- 文件消息和系统提示消息不可收藏
- 收藏项按时间倒序展示
- 点击收藏项直接复制到剪贴板

## API 说明

### 现有接口

- `POST /upload`
  - 上传单文件，字段名固定为 `file`
- `POST /api/cleanup`
  - 清理物理文件

### v1.5 新增接口

- `GET /api/favorites`
  - 获取收藏列表
- `POST /api/favorites`
  - 新增收藏
  - 请求体：
    ```json
    {
      "source_message_id": 123,
      "content": "example text"
    }
    ```
- `DELETE /api/favorites/:id`
  - 删除收藏
- `POST /api/history/clear`
  - 清空聊天记录

## Socket 事件

### 现有事件

- `history`
- `chat message`
- `system cleanup`

### v1.5 新增事件

- `favorites updated`
- `history cleared`

## Docker 部署

### 当前方案

当前项目的 `docker-compose.yml` 是本地构建模式：

```yaml
services:
  lan-drop-chat:
    build: .
```

这意味着：

- 容器镜像来自 NAS 上的本地项目目录
- 不是自动从 GitHub 拉取代码
- 你更新代码后，需要在 NAS 上重新构建容器

### 群晖部署步骤

假设项目目录在：

```text
/volume1/Docker/lan-drop-chat
```

#### 1. 将项目文件同步到群晖

至少同步这些文件：

- `server.js`
- `public/index.html`
- `package.json`
- `package-lock.json`
- `Dockerfile`
- `docker-compose.yml`

#### 2. 在群晖 SSH 中重建

```bash
cd /volume1/Docker/lan-drop-chat
docker compose up -d --build
```

#### 3. 查看日志

```bash
docker compose logs -f
```

启动成功时会看到：

```text
Server running at http://localhost:3000
```

## 更新方式说明

### 方式 A：继续使用当前 `build: .`

这是最简单、最直接的方式。

更新流程：

1. 把 GitHub 上的新代码拉到 NAS
2. 进入项目目录
3. 执行：

```bash
git pull
docker compose up -d --build
```

特点：

- 简单
- 可控
- 适合个人 NAS
- 不是“自动更新”

### 方式 B：改成镜像发布模式

本项目已经内置 GitHub Actions 工作流：

```text
.github/workflows/docker-image.yml
```

它会在以下时机自动构建并推送 GHCR 镜像：

- push 到 `main`
- push `v*` tag
- 手动触发 `workflow_dispatch`

如果你希望 NAS 不再依赖本地源码目录，而是直接拉取构建好的镜像，则可以使用这个工作流产出的镜像：

- 默认镜像地址：

```text
ghcr.io/jtfgu233/lan-drop-chat:latest
```

- 群晖 `docker-compose.yml` 可改为：

```yaml
services:
  lan-drop-chat:
    image: ghcr.io/jtfgu233/lan-drop-chat:latest
    container_name: lan-drop-chat
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    restart: unless-stopped
    environment:
      - NODE_ENV=production
```

然后在 NAS 上更新时执行：

```bash
docker compose pull
docker compose up -d
```

特点：

- 部署更干净
- NAS 不需要保留完整源码
- 更适合长期维护
- 依然不是“自动拉 GitHub 代码”，而是“手动或定时拉镜像”

### GHCR 首次使用说明

第一次推送镜像后，你可能需要在 GitHub 仓库或 Packages 页面确认：

- `ghcr.io/jtfgu233/lan-drop-chat` 包已生成
- 如果仓库是公开项目，建议将该 package 也设置为 `public`

如果群晖拉取公开 GHCR 镜像失败，再检查：

- 仓库 Actions 是否执行成功
- 包可见性是否为公开
- 群晖 Docker 是否可访问 `ghcr.io`

### 结论

如果你把代码发到 GitHub：

- **当前这份 YAML 不会自动从 GitHub 拉取更新**
- 它只会根据 NAS 当前目录里的文件本地构建
- 你至少还需要：
  - `git pull && docker compose up -d --build`
- 如果你想尽量接近自动更新，建议下一步切到“GitHub Actions + 镜像仓库 + compose pull”方案

## 推荐的 GitHub 发布做法

### 1. 初始化仓库

```bash
git init
git add .
git commit -m "feat: lan-drop-chat v1.5"
```

### 2. 添加远程仓库

```bash
git remote add origin <your-github-repo-url>
git branch -M main
git push -u origin main
```

### 3. 推荐不要提交的内容

本项目已经附带 `.gitignore`，默认忽略：

- `node_modules/`
- `data/`
- `uploads/`
- 日志和系统文件

### 4. 开源许可证

本项目已经附带：

```text
LICENSE
```

当前使用 `MIT License`。

## 后续可扩展方向

- 设备别名
- 导出聊天记录
- 收藏导出
- 独立的移动端优化

## 许可

本项目使用 `MIT License`。
