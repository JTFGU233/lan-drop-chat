FROM node:18-alpine

# 安装构建 sqlite3 所需的依赖
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install

# 复制源代码
COPY . .

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["npm", "start"]
