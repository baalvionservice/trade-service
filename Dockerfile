FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev

FROM base AS final
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3025
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
