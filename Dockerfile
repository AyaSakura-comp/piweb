FROM node:22-alpine

RUN apk add --no-cache git bash

WORKDIR /app

# Install pi globally (the gateway shells out to it)
RUN npm install -g @mariozechner/pi-coding-agent

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output
COPY dist/ dist/
COPY .env.example ./
COPY LICENSE README.md ./

# Create non-root user and data directory
RUN adduser -D -u 1001 gateway \
  && mkdir -p /data /home/gateway/.pi/agent \
  && chown -R gateway:gateway /data /home/gateway

USER gateway

ENV SESSIONS_DIR=/data/sessions
ENV DB_PATH=/data/gateway.db
ENV PI_CWD=/home/gateway
ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
