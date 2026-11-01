# syntax=docker/dockerfile:1
# Dev-образ микрофронтенда кабинета: `ng serve` на порту 4201 с --serve-path /mf/cabinet/ (спека 014, 4.9).
FROM node:24.22.1-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/ui/cabinet apps/ui/cabinet
COPY apps/ui/serve.sh /usr/local/bin/serve.sh
WORKDIR /repo/apps/ui/cabinet
# `ng serve` под node пишет кэш сборки в apps/ui/cabinet/.angular.
RUN chown node:node /repo/apps/ui/cabinet
USER node
CMD ["sh", "/usr/local/bin/serve.sh"]
