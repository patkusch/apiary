# Agent Swarm Dashboard Dockerfile
# Multi-stage build: build the Vite app and serve with nginx

# Stage 1: Build
FROM oven/bun:latest AS builder

WORKDIR /build

# Copy package files
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY . ./

# Build for production
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN bun run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy built assets
COPY --from=builder /build/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
