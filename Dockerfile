FROM node:22-bookworm

WORKDIR /app

# نصب Java 21 از Adoptium
RUN curl -fsSL https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse \
    -o /tmp/java.tar.gz \
    && mkdir -p /opt/java \
    && tar -xzf /tmp/java.tar.gz -C /opt/java --strip-components=1 \
    && rm /tmp/java.tar.gz

ENV JAVA_HOME=/opt/java
ENV PATH="/opt/java/bin:${PATH}"

# Node dependencies
COPY package.json ./
RUN npm install --omit=dev

# Application
COPY server.js ./

# Minecraft data
RUN mkdir -p /data/server /data/backups

ENV PORT=3000
ENV MC_PORT=25565
ENV DATA_DIR=/data

EXPOSE 3000
EXPOSE 25565

CMD ["node", "server.js"]
