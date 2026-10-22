FROM node:22.23.4-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.23.4-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/openapi.json ./
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
CMD ["node", "dist/index.js"]
