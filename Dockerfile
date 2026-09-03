FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openjdk-21-jre-headless \
        curl \
        ca-certificates \
        tar \
        gzip \
        unzip \
        procps \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./

RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /data/server /data/backups

ENV PORT=3000
ENV MC_PORT=25565
ENV DATA_DIR=/data

EXPOSE 3000
EXPOSE 25565

CMD ["node", "server.js"]
