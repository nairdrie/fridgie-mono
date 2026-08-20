# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
#
# IMPORTANT: build from the REPO ROOT, not from apps/api — the API imports from
# packages/shared, so that directory has to be inside the build context:
#
#   docker build -f apps/api/Dockerfile .
#
# The layout inside the image mirrors the repo (apps/api + packages/shared) so
# the `@fridgie/shared/*` tsconfig path and lexorank resolution both still work.
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY apps/api/package.json apps/api/bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY apps/api/package.json apps/api/bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# packages/shared is source-only but declares its own dependency (lexorank),
# which must be installed for the import to resolve at runtime.
RUN mkdir -p /temp/shared
COPY packages/shared/package.json /temp/shared/
RUN cd /temp/shared && bun install --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules apps/api/node_modules
COPY . .

# copy production dependencies and source code into final image
FROM base AS release

# ffmpeg samples still frames out of a TikTok video for the recipe importer.
# Recipe videos put their quantities in on-screen text while the audio says
# "add a bit of this", so the frames are where the numbers actually are — see
# apps/api/utils/tiktok.ts. Installed before the USER switch below, since apt
# needs root. Costs roughly 250MB of image; the importer degrades to
# caption-and-transcript rather than failing if it is ever dropped.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=install /temp/prod/node_modules ./apps/api/node_modules
COPY --from=install /temp/shared/node_modules ./packages/shared/node_modules
COPY --from=prerelease /usr/src/app/apps/api/package.json ./apps/api/
COPY --from=prerelease /usr/src/app/apps/api/tsconfig.json ./apps/api/
COPY --from=prerelease /usr/src/app/apps/api/index.ts ./apps/api/
COPY --from=prerelease /usr/src/app/apps/api/utils ./apps/api/utils
COPY --from=prerelease /usr/src/app/apps/api/middleware ./apps/api/middleware
COPY --from=prerelease /usr/src/app/apps/api/api ./apps/api/api
COPY --from=prerelease /usr/src/app/packages/shared ./packages/shared

WORKDIR /usr/src/app/apps/api

# run the app
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "index.ts" ]
