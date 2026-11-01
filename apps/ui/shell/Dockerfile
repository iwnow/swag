# syntax=docker/dockerfile:1
# Dev-образ каркаса: `ng serve` с прокси /api, /auth, /grafana и /mf/* (спека 014, 4.9).
FROM node:24.22.1-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/ui/shell apps/ui/shell
COPY apps/ui/serve.sh /usr/local/bin/serve.sh
WORKDIR /repo/apps/ui/shell
# `ng serve` под node пишет кэш сборки в apps/ui/shell/.angular.
RUN chown node:node /repo/apps/ui/shell
USER node
CMD ["sh", "/usr/local/bin/serve.sh"]
