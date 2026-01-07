export class PokedRaceMCPClient {
  private serverUrl: string = "";
  private apiKey: string = "";
  private requestId: number = 0;
  private serverInfo: any = null;

  async connect(serverUrl: string, apiKey?: string): Promise<void> {
    console.log(`Connecting to MCP server at ${serverUrl}...`);

    this.serverUrl = serverUrl;
    this.apiKey = apiKey || "";

    // Initialize the connection
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "pokedbots-client",
        version: "1.0.0",
      },
    });

    this.serverInfo = result;
    console.log("Connected to MCP server successfully!");
    console.log("Server Info:", result.serverInfo);
  }

  private async sendRequest(method: string, params: any = {}): Promise<any> {
    this.requestId++;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId,
        method,
        params,
      }),
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`JSON-RPC Error: ${data.error.message} (code: ${data.error.code})`);
    }

    return data.result;
  }

  async listTools(): Promise<any> {
    console.log("Fetching available tools from server...");
    const result = await this.sendRequest("tools/list", {});
    return result;
  }

  async callTool(toolName: string, args: Record<string, any> = {}): Promise<any> {
    console.log(`Calling tool: ${toolName}`);
    console.log(`Arguments:`, JSON.stringify(args, null, 2));

    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    });

    return result;
  }

  async listResources(): Promise<any> {
    console.log("Fetching available resources from server...");
    const result = await this.sendRequest("resources/list", {});
    return result;
  }

  async listPrompts(): Promise<any> {
    console.log("Fetching available prompts from server...");
    const result = await this.sendRequest("prompts/list", {});
    return result;
  }

  getServerInfo(): any {
    return this.serverInfo;
  }

  async close(): Promise<void> {
    console.log("Disconnected from MCP server");
  }
}
