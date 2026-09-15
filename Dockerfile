FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runtime

ARG AGENT_BRIDGE_BUILD_REVISION=""

LABEL org.opencontainers.image.source="https://github.com/creatornader/agent-bridge"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.revision="${AGENT_BRIDGE_BUILD_REVISION}"

ENV NODE_ENV=production
ENV AGENT_BRIDGE_BUILD_REVISION="${AGENT_BRIDGE_BUILD_REVISION}"
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
