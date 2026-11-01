# syntax=docker/dockerfile:1
# Dev-образ микрофронтенда супервизора: `ng serve` на порту 4203 с --serve-path /mf/supervisor/ (спека 014, 4.9).
FROM node:24.22.1-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/ui/supervisor apps/ui/supervisor
WORKDIR /repo/apps/ui/supervisor
# `ng serve` под node пишет кэш сборки в apps/ui/supervisor/.angular.
RUN chown node:node /repo/apps/ui/supervisor
USER node
CMD ["npm", "run", "start"]
