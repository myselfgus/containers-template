import { WorkerEntrypoint } from 'cloudflare:workers';
import { nanoid } from 'nanoid';

export class ContainerManagerRPC extends WorkerEntrypoint<Env> {
	/**
	 * Create SDK environment for building an MCP server
	 * Returns container ID that can be used for subsequent build operations
	 */
	async createSDKEnvironment(serverId: string, dependencies: string[] = []) {
		try {
			// Generate unique container ID for this server
			const containerId = `mcp-${serverId}-${nanoid(8)}`;

			// Get Durable Object instance for this container
			const id = this.env.MY_CONTAINER.idFromName(containerId);
			const container = this.env.MY_CONTAINER.get(id);

			// Initialize container with health check
			const response = await container.fetch('http://container/health');

			if (!response.ok) {
				throw new Error('Container failed to start');
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
				ready: true,
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
	 * Takes TypeScript code, builds it, and returns bundled worker script
	 */
	async buildMCPServer(containerId: string, serverId: string, code: { [filename: string]: string }) {
		try {
			const buildId = nanoid();

			// Create build directory
			await this.executeInContainer(containerId, 'mkdir -p /tmp/build', serverId);

			// Write all code files
			for (const [filename, content] of Object.entries(code)) {
				// Write file via container API
				const id = this.env.MY_CONTAINER.idFromName(containerId);
				const container = this.env.MY_CONTAINER.get(id);

				await container.fetch('http://container/write-file', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						path: `/tmp/build/${filename}`,
						content
					})
				});
			}

			// Install dependencies
			const installResult = await this.executeInContainer(
				containerId,
				'cd /tmp/build && npm install',
				serverId
			);

			if (!installResult.success) {
				return {
					success: false,
					error: 'Failed to install dependencies: ' + installResult.error
				};
			}

			// Build with wrangler
			const buildResult = await this.executeInContainer(
				containerId,
				'cd /tmp/build && npx wrangler deploy --dry-run --outdir=/tmp/dist',
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
