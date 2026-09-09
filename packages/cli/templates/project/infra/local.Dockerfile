FROM node:26-alpine

RUN npm install --global pnpm@11.15.1 \
  && pnpm config set store-dir /pnpm/store

WORKDIR /workspace

EXPOSE 5173 8787
