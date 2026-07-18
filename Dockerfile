FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime

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
