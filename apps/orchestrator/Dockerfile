# Образ для локального запуска: код исполняется из исходников через type stripping Node 24, без сборки.
FROM node:24.20.0-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
COPY packages/api-core/package.json packages/api-core/
COPY packages/orchestrator-core/package.json packages/orchestrator-core/
COPY packages/agent-core/package.json packages/agent-core/
COPY apps/api/package.json apps/api/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/agent/package.json apps/agent/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages packages
COPY apps/orchestrator apps/orchestrator
USER node
CMD ["node", "apps/orchestrator/src/main.ts"]
