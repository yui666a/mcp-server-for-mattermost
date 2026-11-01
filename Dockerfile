FROM node:26.13.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "src/main.ts"]
