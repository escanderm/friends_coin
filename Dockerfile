FROM node:24.16.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js blockchain.js protocol.js peer-protocol.js storage.js cli.js network-config.js ./
COPY networks/mainnet.json networks/testnet.json ./networks/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8088 8089
VOLUME ["/data"]
ENTRYPOINT ["node", "server.js"]
CMD ["--data-dir", "/data", "--host", "0.0.0.0"]
