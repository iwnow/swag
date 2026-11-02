# syntax=docker/dockerfile:1
# Образ песочницы узла: код исполняется из исходников через type stripping Node 24, без сборки (спека 026, 4.8).
FROM node:24.22.1-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
# Манифесты всех workspace-пакетов: новый пакет не требует правки этого файла (REQ-001-16).
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages packages
COPY apps/node-host apps/node-host
USER node
CMD ["node", "apps/node-host/src/main.ts"]
