# MCP Remote Server Templates Guide

## 📦 Container Base Image for Cloudflare Workers

Esta imagem container foi projetada para ser usada por LLMs na criação de MCP Remote Servers como Cloudflare Workers.

## 🚀 Templates Disponíveis

Todos os templates estão instalados em `/templates/` com suas dependências prontas.

### 1. **remote-mcp-authless**
```
Path: /templates/remote-mcp-authless
```
**Uso:** Base fundamental para criar MCP remote servers sem autenticação
**Quando usar:** Sempre como ponto de partida para novos MCP servers
**Dependências:** @modelcontextprotocol/sdk, agents, zod

### 2. **tool-calling**
```
Path: /templates/tool-calling
```
**Uso:** Agents com capacidade de chamar ferramentas externas
**Quando usar:** Quando o agent precisa executar ações (API calls, computações)
**Dependências:** agents, ai, hono, workers-ai-provider, zod

### 3. **orchestrator-workers**
```
Path: /templates/orchestrator-workers
```
**Uso:** Coordenar múltiplos Cloudflare Workers
**Quando usar:** Sistemas complexos com múltiplos workers especializados
**Dependências:** agents, ai, hono, workers-ai-provider, zod

### 4. **agent-task-manager**
```
Path: /templates/agent-task-manager
```
**Uso:** Gerenciar tarefas complexas com decomposição
**Quando usar:** Tarefas que precisam ser quebradas em sub-tarefas
**Dependências:** agents, ai, hono, workers-ai-provider, zod

### 5. **routing**
```
Path: /templates/routing
```
**Uso:** Roteamento inteligente de requisições
**Quando usar:** Direcionar diferentes tipos de requests para handlers específicos
**Dependências:** agents, ai, hono, workers-ai-provider, zod

### 6. **parallelisation**
```
Path: /templates/parallelisation
```
**Uso:** Executar múltiplas tarefas em paralelo
**Quando usar:** Processar múltiplas operações simultaneamente
**Dependências:** agents, ai, hono, workers-ai-provider, zod

### 7. **e2e**
```
Path: /templates/e2e
```
**Uso:** Testes end-to-end completos
**Quando usar:** Validar workflows completos do sistema
**Dependências:** vitest, vite

## 🔧 Dependências Globais Instaladas

```json
{
  "@modelcontextprotocol/sdk": "^1.19.1",
  "@anthropic-ai/sdk": "^0.39.0",
  "@cloudflare/ai": "^1.2.0",
  "agents": "^0.2.21",
  "ai": "^5.0.60",
  "hono": "^4.9.9",
  "workers-ai-provider": "^2.0.0",
  "zod": "^3.25.76"
}
```

## 🎯 Como Usar (para LLMs)

### Criar Novo MCP Remote Server

1. **Copie o template base:**
```bash
cp -r /templates/remote-mcp-authless /app/my-new-server
cd /app/my-new-server
```

2. **Customize o código:**
```typescript
// src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk';
// ... seu código aqui
```

3. **Configure wrangler.jsonc:**
```jsonc
{
  "name": "my-mcp-server",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01"
}
```

4. **Deploy na Cloudflare:**
```bash
wrangler deploy
```

### Combinar Templates

Para funcionalidades complexas, combine múltiplos templates:

```bash
# Base MCP + Tool Calling + Routing
cp -r /templates/remote-mcp-authless /app/my-server
cp /templates/tool-calling/src/tools/* /app/my-server/src/tools/
cp /templates/routing/src/router.ts /app/my-server/src/
```

## ⚠️ IMPORTANTE

### ❌ NÃO FAZER:
- **NÃO exponha portas locais** (EXPOSE, localhost, 127.0.0.1)
- **NÃO use servidores HTTP locais** (express.listen, http.createServer)
- **NÃO faça bind em portas** (tudo roda na Cloudflare)

### ✅ FAZER:
- Use **Cloudflare Workers fetch handler**
- Use **Durable Objects** para estado
- Use **Workers AI** para LLM calls
- Use **Hono** para routing (já configurado nos templates)

## 📋 Manifest de Templates

Acesse `/templates/manifest.json` para ver todos templates disponíveis programaticamente:

```bash
cat /templates/manifest.json
```

## 🌐 Runtime

- **Platform:** Cloudflare Workers
- **Runtime:** Cloudflare Containers
- **Node Version:** 20 (Alpine)
- **Networking:** Cloudflare-managed (sem localhost)

## 📚 Recursos

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [MCP SDK Docs](https://modelcontextprotocol.io/)
- [Agents Framework](https://github.com/cloudflare/agents)
