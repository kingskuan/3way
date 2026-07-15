FROM node:20-slim

WORKDIR /app

# 只复制清单以便利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# 源码与静态资源
COPY src/ ./src/
COPY public/ ./public/

# Railway 会通过 PORT 环境变量注入实际端口；HOST 由 config.js 自动切成 0.0.0.0
ENV NODE_ENV=production
ENV DOCKER_CONTAINER=1
ENV STATE_DIR=/data

# 状态持久化目录：在 Railway 上通过 Project → Volume 挂 /data
# （Railway 不支持 Dockerfile 的 VOLUME 指令，得走它们自己的 Volume 面板）

EXPOSE 8080

# 用 tini 之类的其实更好，但 Railway 的容器 stop 也发 SIGTERM，node 能收到就够用
CMD ["node", "src/server.js"]
