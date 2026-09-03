FROM eclipse-temurin:21-jdk-jammy

# Install Node.js 22
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       ca-certificates \
       unzip \
       procps \
       tar \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
