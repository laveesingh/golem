FROM node:22.22.3-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ procps jq && rm -rf /var/lib/apt/lists/*
USER node
