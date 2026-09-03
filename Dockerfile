FROM eclipse-temurin:21-jre

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        unzip \
        procps \
        tar \
        gzip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV PORT=3000
ENV MC_PORT=25565

EXPOSE 3000
EXPOSE 25565

CMD ["npm", "start"]
