# syntax=docker/dockerfile:1
# Образ для локального запуска: код исполняется из исходников через type stripping Node 24, без сборки.
FROM node:24.20.0-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
# Манифесты всех workspace-пакетов: новый пакет не требует правки этого файла (REQ-001-16).
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages packages
COPY apps/agent apps/agent
USER node
CMD ["node", "apps/agent/src/main.ts"]
