FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=4174
ENV DATABASE_PATH=./data/gateway.db
EXPOSE 4174

CMD ["node", "server/index.js"]
