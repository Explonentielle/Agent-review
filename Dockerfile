# syntax=docker/dockerfile:1
# Image de la plateforme (déploiement serveur, voir docs/deploiement.md).
# Deux étages : compilation TypeScript, puis image d'exécution sans outils de build ni dépendances de développement.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# Version de la CLI Claude Code : à figer (ex. --build-arg CLAUDE_CODE_VERSION=2.1.0) pour une image reproductible
ARG CLAUDE_CODE_VERSION=latest
ENV NODE_ENV=production \
    HOME=/app/data/home \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data
# git : copies de dépôts et branches des agents ; la CLI Claude Code : les agents
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
COPY public ./public
# Utilisateur sans droits : l'application n'écrit que dans le volume de données
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --home-dir /app/data/home --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /app/data \
 && chown -R app:app /app/data
USER app
EXPOSE 4321
# Répond tant que le serveur écoute (la réponse peut être 401 quand la connexion est activée)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4321) + '/api/me').then(() => process.exit(0), () => process.exit(1))"
# Le dossier personnel (configuration de la CLI Claude Code) vit dans le volume de données
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node dist/index.js"]
