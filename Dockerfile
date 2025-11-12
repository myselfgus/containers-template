# syntax=docker/dockerfile:1

# Multi-stage build for optimized MCP Remote Server base image
FROM node:20-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    ca-certificates \
    python3 \
    make \
    g++

WORKDIR /app

# Stage 1: Install global dependencies
FROM base AS globals
RUN npm install -g \
    @modelcontextprotocol/sdk \
    @anthropic-ai/sdk \
    @anthropic-ai/claude-agent-sdk \
    @cloudflare/ai \
    agents \
    zod \
    typescript \
    tsx \
    wrangler \
    openai \
    @langchain/core \
    @langchain/openai \
    && npm cache clean --force

# Stage 2: Build application dependencies
FROM base AS builder

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm install

# Copy application source
COPY . .

# Build TypeScript if needed
RUN if [ -f tsconfig.json ]; then npm run build 2>/dev/null || tsc 2>/dev/null || true; fi

# Stage 3: Create production image with templates
FROM base AS production

# Copy global packages from globals stage
COPY --from=globals /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=globals /usr/local/bin /usr/local/bin

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Note: No application code to copy - this is a template base image

# Create templates directory structure
RUN mkdir -p /templates

# Copy essential MCP templates
COPY agents/remote-mcp-authless /templates/remote-mcp-authless
COPY agents/tool-calling /templates/tool-calling
COPY agents/orchestrator-workers /templates/orchestrator-workers
COPY agents/agent-task-manager /templates/agent-task-manager
COPY agents/routing /templates/routing
COPY agents/parallelisation /templates/parallelisation
COPY agents/e2e /templates/e2e

# Install dependencies for each template
RUN for template in /templates/*/; do \
    if [ -f "$template/package.json" ]; then \
        echo "Installing dependencies for $template"; \
        cd "$template" && npm install --omit=dev && npm cache clean --force; \
    fi \
done

# Return to app directory
WORKDIR /app

# Create a templates manifest for easy discovery by LLM
RUN echo '{\n\
  "templates": [\n\
    {"name": "remote-mcp-authless", "path": "/templates/remote-mcp-authless", "description": "Base MCP remote server without authentication - Foundation for MCP workers"},\n\
    {"name": "tool-calling", "path": "/templates/tool-calling", "description": "Agent with tool calling capabilities - Enable AI to use tools"},\n\
    {"name": "orchestrator-workers", "path": "/templates/orchestrator-workers", "description": "Worker orchestration system - Coordinate multiple Cloudflare Workers"},\n\
    {"name": "agent-task-manager", "path": "/templates/agent-task-manager", "description": "Task management for agents - Complex task decomposition"},\n\
    {"name": "routing", "path": "/templates/routing", "description": "Intelligent request routing - Smart request distribution"},\n\
    {"name": "parallelisation", "path": "/templates/parallelisation", "description": "Parallel task execution - Execute multiple tasks concurrently"},\n\
    {"name": "e2e", "path": "/templates/e2e", "description": "End-to-end testing framework - Test complete workflows"}\n\
  ],\n\
  "dependencies_installed": true,\n\
  "version": "1.0.0",\n\
  "platform": "cloudflare-workers",\n\
  "runtime": "cloudflare-containers"\n\
}' > /templates/manifest.json

# Set environment variables for Cloudflare Workers/Containers
ENV NODE_ENV=production
ENV MCP_TEMPLATES_PATH=/templates
ENV CLOUDFLARE_WORKERS=true
ENV PATH="/usr/local/bin:${PATH}"

# NO EXPOSE - Running on Cloudflare, not localhost
# NO PORTS - Cloudflare handles all networking

# Health check for container readiness (not network port)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Default command - Cloudflare will override with worker entry point
CMD ["node", "--version"]
