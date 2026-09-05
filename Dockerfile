# One container is the whole game: it serves the built client at `/` and runs
# the authoritative Colyseus room on the same origin. That is what keeps the
# link you hand someone to a single hostname over HTTPS/WSS.

# ---- build ----------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install against the lockfile first, so a source-only edit reuses this layer.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
# Builds shared, then the server, then the client bundle.
RUN npm run build

# Drop dev dependencies so they never reach the runtime image.
RUN npm prune --omit=dev

# ---- run ------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Colyseus binds 0.0.0.0; Fly routes to whatever PORT says.
ENV PORT=8080
EXPOSE 8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

# Don't run the game as root.
USER node

CMD ["node", "server/dist/index.js"]
