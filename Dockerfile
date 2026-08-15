FROM node:20-slim

WORKDIR /app

# Python 运行时 · Lighter 官方 SDK 依赖（Round 277 引入）：
#   Lighter 的签名器是 Go 编译的 lighter-signer-linux-amd64.so，只被官方 Python
#   SDK 用 ctypes 加载调用。Node 侧通过 tools/lighter-signer.py 子进程走 JSON RPC。
#   base 是 node:20-slim (Debian bookworm) → apt-get 走 python3 + python3-pip；
#   pip 走 --break-system-packages 因为 Debian 12 把系统 site-packages 标成 EXTERNALLY-MANAGED。
#   lighter-sdk 拉的东西比较杂（eth-account/aiohttp/pydantic/...），一次装完 ~80MB。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --break-system-packages --no-cache-dir lighter-sdk \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# 只复制清单以便利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# 源码与静态资源
COPY src/ ./src/
COPY public/ ./public/
COPY tools/ ./tools/

# Railway 会通过 PORT 环境变量注入实际端口；HOST 由 config.js 自动切成 0.0.0.0
ENV NODE_ENV=production
ENV DOCKER_CONTAINER=1
ENV STATE_DIR=/data

# 状态持久化目录：在 Railway 上通过 Project → Volume 挂 /data
# （Railway 不支持 Dockerfile 的 VOLUME 指令，得走它们自己的 Volume 面板）

EXPOSE 8080

# 用 tini 之类的其实更好，但 Railway 的容器 stop 也发 SIGTERM，node 能收到就够用
CMD ["node", "src/server.js"]
