import { WorkerEntrypoint } from 'cloudflare:workers';
import { nanoid } from 'nanoid';

export class ContainerManagerRPC extends WorkerEntrypoint<Env> {
	/**
	 * Create SDK environment for building an MCP server
	 * Copies remote-mcp-authless template and personalizes it for the new server
	 * Returns container ID that can be used for subsequent build operations
	 */
	async createSDKEnvironment(serverId: string, dependencies: string[] = []) {
		try {
			// Generate unique container ID for this server
			const containerId = `mcp-${serverId}-${nanoid(8)}`;

			// Get Durable Object instance for this container
			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			// Container initialized via RPC binding - no fetch needed

			// Create workspace directory for this server
			const workspacePath = `/workspace/${serverId}`;
			await this.executeInContainer(containerId, `mkdir -p ${workspacePath}`, serverId);

			// Copy remote-mcp-authless template to workspace
			const copyResult = await this.executeInContainer(
				containerId,
				`cp -r /templates/remote-mcp-authless/* ${workspacePath}/`,
				serverId
			);

			if (!copyResult.success) {
				throw new Error('Failed to copy template: ' + copyResult.error);
			}

			// Read template files to personalize
			const indexResponse = await container.fetch('http://container/read-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: `${workspacePath}/src/index.ts` })
			});
			const indexData = await indexResponse.json() as { content?: string; error?: string };

			if (indexData.error || !indexData.content) {
				throw new Error('Failed to read template index.ts');
			}

			// Personalize the template: rename class and server name
			const className = serverId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
			let personalizedIndex = indexData.content
				.replace(/class MyMCP/g, `class ${className}MCP`)
				.replace(/MyMCP\.serveSSE/g, `${className}MCP.serveSSE`)
				.replace(/MyMCP\.serve/g, `${className}MCP.serve`)
				.replace(/name: "Authless Calculator"/g, `name: "${serverId}"`)
				.replace(/version: "1\.0\.0"/g, `version: "1.0.0"`)
				// Remove example tools (add, calculate)
				.replace(/\/\/ Simple addition tool[\s\S]*?\}\);/g, '// Add your tools here using this.server.tool()')
				.replace(/\/\/ Calculator tool[\s\S]*?\}\,?\s*\);/g, '');

			// Write personalized index.ts
			await container.fetch('http://container/write-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: `${workspacePath}/src/index.ts`,
					content: personalizedIndex
				})
			});

			// Read and personalize wrangler.jsonc
			const wranglerResponse = await container.fetch('http://container/read-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: `${workspacePath}/wrangler.jsonc` })
			});
			const wranglerData = await wranglerResponse.json() as { content?: string; error?: string };

			if (wranglerData.content) {
				const personalizedWrangler = wranglerData.content
					.replace(/"name": "remote-mcp-server-authless"/g, `"name": "${serverId}"`)
					.replace(/"new_sqlite_classes": \["MyMCP"\]/g, `"new_sqlite_classes": ["${className}MCP"]`)
					.replace(/"class_name": "MyMCP"/g, `"class_name": "${className}MCP"`);

				await container.fetch('http://container/write-file', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						path: `${workspacePath}/wrangler.jsonc`,
						content: personalizedWrangler
					})
				});
			}

			// Record in D1
			await this.env.DB.prepare(`
				INSERT INTO container_executions (id, server_id, container_id, command, status, started_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`).bind(
				nanoid(),
				serverId,
				containerId,
				'initialize',
				'completed',
				Date.now()
			).run();

			return {
				success: true,
				containerId,
				workspacePath,
				ready: true,
				template: 'remote-mcp-authless',
				sdks: ['@modelcontextprotocol/sdk', 'agents', 'zod', 'typescript', 'wrangler'],
				dependencies
			};
		} catch (error) {
			console.error('Failed to create SDK environment:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Execute command in container
	 * Returns execution ID and output
	 */
	async executeInContainer(containerId: string, command: string, serverId?: string) {
		try {
			const executionId = nanoid();

			// Record execution start
			if (serverId) {
				await this.env.DB.prepare(`
					INSERT INTO container_executions (id, server_id, container_id, command, status, started_at)
					VALUES (?, ?, ?, ?, ?, ?)
				`).bind(
					executionId,
					serverId,
					containerId,
					command,
					'running',
					Date.now()
				).run();
			}

			// Get container instance
			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			// Execute command via container's exec endpoint
			const response = await container.fetch('http://container/exec', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ command })
			});

			const result = await response.json() as { output?: string; error?: string };

			// Update execution record
			if (serverId) {
				await this.env.DB.prepare(`
					UPDATE container_executions
					SET status = ?, output = ?, error = ?, completed_at = ?
					WHERE id = ?
				`).bind(
					result.error ? 'failed' : 'completed',
					result.output || null,
					result.error || null,
					Date.now(),
					executionId
				).run();
			}

			return {
				success: !result.error,
				executionId,
				output: result.output,
				error: result.error
			};
		} catch (error) {
			console.error('Failed to execute in container:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Build MCP server in container
	 * Reads from workspace, installs dependencies, builds with wrangler
	 */
	async buildMCPServer(containerId: string, serverId: string, code: { [filename: string]: string }) {
		try {
			const buildId = nanoid();
			const workspacePath = `/workspace/${serverId}`;

			// If code is provided (legacy), write it to workspace (shouldn't happen with new flow)
			if (code && Object.keys(code).length > 0) {
				console.warn('buildMCPServer received code - this should not happen with new flow');
				for (const [filename, content] of Object.entries(code)) {
					const id = this.env.MY_CONTAINER.idFromName(containerId);
					const container = this.env.MY_CONTAINER.get(id);

					await container.fetch('http://container/write-file', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							path: `${workspacePath}/${filename}`,
							content
						})
					});
				}
			}

			// Install dependencies from workspace
			const installResult = await this.executeInContainer(
				containerId,
				`cd ${workspacePath} && npm install`,
				serverId
			);

			if (!installResult.success) {
				return {
					success: false,
					error: 'Failed to install dependencies: ' + installResult.error
				};
			}

			// Build with wrangler from workspace
			const buildResult = await this.executeInContainer(
				containerId,
				`cd ${workspacePath} && npx wrangler deploy --dry-run --outdir=/tmp/dist`,
				serverId
			);

			if (!buildResult.success) {
				return {
					success: false,
					error: 'Build failed: ' + buildResult.error
				};
			}

			// Read bundled script
			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			const scriptResponse = await container.fetch('http://container/read-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/tmp/dist/index.js' })
			});

			const scriptData = await scriptResponse.json() as { content?: string; error?: string };

			if (scriptData.error) {
				return {
					success: false,
					error: 'Failed to read built script: ' + scriptData.error
				};
			}

			return {
				success: true,
				buildId,
				scriptContent: scriptData.content
			};
		} catch (error) {
			console.error('Failed to build MCP server:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * List all active containers
	 */
	async listContainers() {
		try {
			const result = await this.env.DB.prepare(`
				SELECT DISTINCT container_id, server_id, MAX(started_at) as last_used
				FROM container_executions
				WHERE status IN ('running', 'completed')
				GROUP BY container_id
				ORDER BY last_used DESC
				LIMIT 100
			`).all();

			return {
				success: true,
				containers: result.results || []
			};
		} catch (error) {
			console.error('Failed to list containers:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Add tool to MCP server in container
	 * Modifies the src/index.ts file to include the new tool
	 */
	async addToolToServer(containerId: string, serverId: string, toolName: string, toolCode: string) {
		try {
			const workspacePath = `/workspace/${serverId}`;

			// Read current index.ts
			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			const response = await container.fetch('http://container/read-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: `${workspacePath}/src/index.ts` })
			});

			const data = await response.json() as { content?: string; error?: string };

			if (data.error || !data.content) {
				throw new Error('Failed to read index.ts: ' + data.error);
			}

			// Find the init() method and add tool before closing brace
			const initRegex = /async init\(\) \{([\s\S]*?)\n\t\}/;
			const match = data.content.match(initRegex);

			if (!match) {
				throw new Error('Could not find init() method in index.ts');
			}

			const existingInitContent = match[1];
			const updatedInitContent = `async init() {${existingInitContent}\n\n\t\t${toolCode}\n\t}`;
			const updatedIndex = data.content.replace(initRegex, updatedInitContent);

			// Write updated index.ts
			await container.fetch('http://container/write-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: `${workspacePath}/src/index.ts`,
					content: updatedIndex
				})
			});

			return {
				success: true,
				message: `Tool '${toolName}' added to ${workspacePath}/src/index.ts`
			};
		} catch (error) {
			console.error('Failed to add tool to server:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Add resource to MCP server in container
	 * Modifies the src/index.ts file to include the new resource
	 */
	async addResourceToServer(containerId: string, serverId: string, resourceCode: string) {
		try {
			const workspacePath = `/workspace/${serverId}`;

			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			const response = await container.fetch('http://container/read-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: `${workspacePath}/src/index.ts` })
			});

			const data = await response.json() as { content?: string; error?: string };

			if (data.error || !data.content) {
				throw new Error('Failed to read index.ts: ' + data.error);
			}

			const initRegex = /async init\(\) \{([\s\S]*?)\n\t\}/;
			const match = data.content.match(initRegex);

			if (!match) {
				throw new Error('Could not find init() method in index.ts');
			}

			const existingInitContent = match[1];
			const updatedInitContent = `async init() {${existingInitContent}\n\n\t\t${resourceCode}\n\t}`;
			const updatedIndex = data.content.replace(initRegex, updatedInitContent);

			await container.fetch('http://container/write-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: `${workspacePath}/src/index.ts`,
					content: updatedIndex
				})
			});

			return {
				success: true,
				message: `Resource added to ${workspacePath}/src/index.ts`
			};
		} catch (error) {
			console.error('Failed to add resource to server:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Add prompt to MCP server in container
	 * Modifies the src/index.ts file to include the new prompt
	 */
	async addPromptToServer(containerId: string, serverId: string, promptCode: string) {
		try {
			const workspacePath = `/workspace/${serverId}`;

			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			const response = await container.fetch('http://container/read-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: `${workspacePath}/src/index.ts` })
			});

			const data = await response.json() as { content?: string; error?: string };

			if (data.error || !data.content) {
				throw new Error('Failed to read index.ts: ' + data.error);
			}

			const initRegex = /async init\(\) \{([\s\S]*?)\n\t\}/;
			const match = data.content.match(initRegex);

			if (!match) {
				throw new Error('Could not find init() method in index.ts');
			}

			const existingInitContent = match[1];
			const updatedInitContent = `async init() {${existingInitContent}\n\n\t\t${promptCode}\n\t}`;
			const updatedIndex = data.content.replace(initRegex, updatedInitContent);

			await container.fetch('http://container/write-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: `${workspacePath}/src/index.ts`,
					content: updatedIndex
				})
			});

			return {
				success: true,
				message: `Prompt added to ${workspacePath}/src/index.ts`
			};
		} catch (error) {
			console.error('Failed to add prompt to server:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Stop container and clean up resources
	 */
	async stopContainer(containerId: string) {
		try {
			// Container will automatically sleep after inactivity
			// Just mark executions as stopped
			await this.env.DB.prepare(`
				UPDATE container_executions
				SET status = 'failed', error = 'Container stopped', completed_at = ?
				WHERE container_id = ? AND status = 'running'
			`).bind(Date.now(), containerId).run();

			return {
				success: true,
				containerId
			};
		} catch (error) {
			console.error('Failed to stop container:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}
}
