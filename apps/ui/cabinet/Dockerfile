# syntax=docker/dockerfile:1
# Dev-образ личного кабинета: `ng serve` с прокси /api (Q-4). Продакшен-сборки в спеке 001 нет.
FROM node:24.22.1-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/ui/cabinet apps/ui/cabinet
WORKDIR /repo/apps/ui/cabinet
# `ng serve` под node пишет кэш сборки в apps/ui/cabinet/.angular.
RUN chown node:node /repo/apps/ui/cabinet
USER node
CMD ["npm", "run", "start"]
