FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.server.json tsconfig.client.json vite.config.ts ./
COPY client ./client
COPY server ./server
# Vite builds the React SPA to dist/client (static files); tsc builds the BFF to dist/server.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/server/main.js"]
