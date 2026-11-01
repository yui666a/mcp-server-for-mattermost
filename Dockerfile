FROM node:26.13.0-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Installed through npm rather than corepack: Node 26 no longer bundles corepack.
RUN npm install -g pnpm@11.25.0 \
 && pnpm install --prod --frozen-lockfile \
 && rm -rf "$(pnpm store path)" ~/.cache/pnpm \
 && npm uninstall -g pnpm && npm cache clean --force
COPY src ./src
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "src/main.ts"]
