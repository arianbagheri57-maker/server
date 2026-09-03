FROM node:22-bookworm

# نصب Java 21 برای اجرای Minecraft
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       openjdk-21-jre-headless \
       curl \
       ca-certificates \
       unzip \
       procps \
       tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# نصب وابستگی‌های Node
COPY package.json ./
RUN npm install --omit=dev

# کد برنامه
COPY server.js ./

# پوشه‌های مربوط به Minecraft و Backup
RUN mkdir -p /data/server /data/backups

ENV PORT=3000
ENV MC_PORT=25565
ENV DATA_DIR=/data

EXPOSE 3000
EXPOSE 25565

CMD ["node", "server.js"]
