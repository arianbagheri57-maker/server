FROM eclipse-temurin:21-jdk-jammy

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip procps \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /data/server /data/backups

ENV PORT=3000
ENV MC_PORT=25565
ENV DATA_DIR=/data
ENV JAVA_TOOL_OPTIONS="-XX:+UseG1GC"

EXPOSE 3000
EXPOSE 25565

VOLUME ["/data"]

CMD ["node", "server.js"]
