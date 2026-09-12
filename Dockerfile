# Built on the official CloakBrowser image: it already carries the stealth
# Chromium, the system libraries it needs, Xvfb (managed Turnstile needs a
# display) and an entrypoint that starts X before running our command.
#
# LICENCE: the CloakBrowser binary is "free to use, no redistribution"
# (BINARY-LICENSE.md in the base image). Its internal-use clause explicitly
# permits storing and running it in Docker images, CI runners and internal
# artifact repositories - so this image may be pushed to an INTERNAL registry
# only, never a public one.
ARG CLOAKBROWSER_VERSION=0.5.10

# Node 24 only for its binary. The base ships Node 20, which predates
# --experimental-strip-types (22.6+), and our sources import each other with
# explicit .ts extensions - a form tsc cannot emit runnable JS from. Lifting one
# binary across is smaller and less brittle than adding an apt repository, and
# keeps the "no build step" property the sources are written for.
FROM node:24-trixie-slim AS node24

FROM cloakhq/cloakbrowser:${CLOAKBROWSER_VERSION}

# Same Debian release as the base (trixie), so the runtime libraries match.
COPY --from=node24 /usr/local/bin/node /usr/local/bin/node

# NOT /app: the base keeps its own binary, LICENSE and README there.
WORKDIR /srv/cf-minter

# Deps first, so a source edit does not re-resolve them.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ src/

ENV PORT=8090 \
    NODE_ENV=production
EXPOSE 8090

# No build step: Node 24 strips the types itself.
CMD ["/usr/local/bin/node", "--experimental-strip-types", "src/index.ts"]
