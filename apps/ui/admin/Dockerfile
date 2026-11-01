# syntax=docker/dockerfile:1
# Dev-образ микрофронтенда администрирования: `ng serve` на порту 4202 с --serve-path /mf/admin/ (спека 014, 4.9).
FROM node:24.22.1-alpine3.23
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json apps/ui/*/package.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/ui/admin apps/ui/admin
WORKDIR /repo/apps/ui/admin
# `ng serve` под node пишет кэш сборки в apps/ui/admin/.angular.
RUN chown node:node /repo/apps/ui/admin
USER node
CMD ["npm", "run", "start"]
