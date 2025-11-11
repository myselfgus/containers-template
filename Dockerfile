# syntax=docker/dockerfile:1

# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    ca-certificates

# Install global npm packages for MCP, Agents, and development tools
RUN npm install -g \
    @modelcontextprotocol/sdk \
    @anthropic-ai/sdk \
    @cloudflare/ai \
    agents \
    zod \
    typescript \
    tsx \
    wrangler \
    && npm cache clean --force

# Copy package files if they exist
COPY package*.json ./

# Install project dependencies (if package.json exists)
RUN if [ -f package.json ]; then npm install; fi

# Copy application source code
COPY . .

# Build TypeScript if tsconfig.json exists
RUN if [ -f tsconfig.json ]; then npm run build 2>/dev/null || tsc 2>/dev/null || true; fi

# Expose port for the application
EXPOSE 8080

# Default command - can be overridden
CMD ["node", "index.js"]
