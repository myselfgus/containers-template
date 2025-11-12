import { Container, getContainer, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { ContainerManagerRPC } from "./rpc";

export class MyContainer extends Container<Env> {
	// Time before container sleeps due to inactivity (default: 30s)
	sleepAfter = "2m";
	// Environment variables for MCP templates
	envVars = {
		MCP_TEMPLATES_PATH: "/templates",
		CLOUDFLARE_WORKERS: "true",
		NODE_ENV: "production",
	};

	// Optional lifecycle hooks
	override onStart() {
		console.log("Container successfully started");
	}

	override onStop() {
		console.log("Container successfully shut down");
	}

	override onError(error: unknown) {
		console.log("Container error:", error);
	}
}

// Export RPC class for service bindings
export { ContainerManagerRPC };

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
	Bindings: Env;
}>();

// Home route with available endpoints
app.get("/", (c) => {
	return c.text(
		"Available endpoints:\n" +
			"GET /container/<ID> - Start a container for each ID with a 2m timeout\n" +
			"GET /lb - Load balance requests over multiple containers\n" +
			"GET /error - Start a container that errors (demonstrates error handling)\n" +
			"GET /singleton - Get a single specific container instance",
	);
});

// Route requests to a specific container using the container ID
app.get("/container/:id", async (c) => {
	const id = c.req.param("id");
	const containerId = c.env.MY_CONTAINER.idFromName(`/container/${id}`);
	const container = c.env.MY_CONTAINER.get(containerId);
	return await container.fetch(c.req.raw);
});

// Demonstrate error handling - this route forces a panic in the container
app.get("/error", async (c) => {
	const container = getContainer(c.env.MY_CONTAINER, "error-test");
	return await container.fetch(c.req.raw);
});

// Load balance requests across multiple containers
app.get("/lb", async (c) => {
	const container = await getRandom(c.env.MY_CONTAINER, 3);
	return await container.fetch(c.req.raw);
});

// Get a single container instance (singleton pattern)
app.get("/singleton", async (c) => {
	const container = getContainer(c.env.MY_CONTAINER);
	return await container.fetch(c.req.raw);
});

// Health check endpoint for container initialization
app.get("/health", (c) => {
	return c.json({ status: "healthy", timestamp: Date.now() });
});

// Execute command in container
app.post("/exec", async (c) => {
	try {
		const { command } = await c.req.json();
		// This would execute in the actual container runtime
		// For now, return mock response
		return c.json({
			output: `Executed: ${command}`,
			success: true
		});
	} catch (error) {
		return c.json({
			error: error instanceof Error ? error.message : 'Unknown error',
			success: false
		}, 500);
	}
});

// Write file to container filesystem
app.post("/write-file", async (c) => {
	try {
		const { path, content } = await c.req.json();
		// This would write to container filesystem
		// For now, return success
		return c.json({
			success: true,
			path,
			bytes: content.length
		});
	} catch (error) {
		return c.json({
			error: error instanceof Error ? error.message : 'Unknown error',
			success: false
		}, 500);
	}
});

// Read file from container filesystem
app.post("/read-file", async (c) => {
	try {
		const { path } = await c.req.json();
		// This would read from container filesystem
		// For now, return mock content
		return c.json({
			content: `// Built MCP server from ${path}`,
			success: true
		});
	} catch (error) {
		return c.json({
			error: error instanceof Error ? error.message : 'Unknown error',
			success: false
		}, 500);
	}
});

export default app;
