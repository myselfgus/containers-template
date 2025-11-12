import { Container } from "@cloudflare/containers";
import { ContainerManagerRPC } from "./rpc";

export class MyContainer extends Container<Env> {
	// Time before container sleeps due to inactivity
	sleepAfter = "2m";
	
	// Environment variables for MCP templates
	envVars = {
		MCP_TEMPLATES_PATH: "/templates",
		CLOUDFLARE_WORKERS: "true",
		NODE_ENV: "production",
	};

	// RPC methods - these are called directly by ContainerManagerRPC
	// No HTTP port needed, no fetch() calls
	async execCommand(command: string) {
		// TODO: Wire up to real container runtime when available
		// For now, return success to allow the flow to continue
		return {
			success: true,
			output: `Executed: ${command}`,
		};
	}

	async writeFile(path: string, content: string) {
		// TODO: Wire up to real container filesystem when available
		return {
			success: true,
			content: content,
		};
	}

	async readFile(path: string) {
		// TODO: Wire up to real container filesystem when available
		return {
			success: true,
			content: `// File content from ${path}`,
		};
	}

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

// Default export for Cloudflare Workers
// This worker is accessed ONLY via RPC, no HTTP endpoints
export default {
	fetch(request: Request, env: Env) {
		// This should never be called directly
		// All access is via RPC through ContainerManagerRPC
		return new Response(
			JSON.stringify({
				error: "This worker is accessed via RPC only. Use service bindings.",
				documentation: "https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/"
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" }
			}
		);
	}
};
