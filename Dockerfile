FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS runtime

LABEL org.opencontainers.image.source="https://github.com/creatornader/agent-bridge"
LABEL org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node sql/migrations ./sql/migrations
COPY --chown=root:root deploy/secret-entrypoint.mjs /usr/local/lib/agent-bridge-secret-entrypoint.mjs
RUN find /usr/local/lib/node_modules -depth -delete \
  && find /usr/local/bin -maxdepth 1 \
    \( -name npm -o -name npx -o -name corepack -o -name yarn -o -name yarnpkg \) \
    -delete

USER node
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "const port=process.env.AGENT_BRIDGE_PORT||'8787';fetch('http://127.0.0.1:'+port+'/readyz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/gateway-main.js"]
