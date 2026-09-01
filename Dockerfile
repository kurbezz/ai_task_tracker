FROM node:20-slim AS frontend

WORKDIR /src/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM rust:1.96-slim-bookworm AS builder

RUN apt-get update \
    && apt-get install --yes --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/ ./backend/
COPY --from=frontend /src/frontend ./frontend/

RUN cargo build --release --manifest-path backend/Cargo.toml

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --create-home app

WORKDIR /app

COPY --from=builder /app/backend/target/release/ai-task-tracker /app/ai-task-tracker
RUN mkdir data && chown app:app data

USER app

EXPOSE 3000

ENV DATABASE_URL=sqlite:data/tracker.db
ENV BIND_ADDR=0.0.0.0:3000

ENTRYPOINT ["/app/ai-task-tracker"]
