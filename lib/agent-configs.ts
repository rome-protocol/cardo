// Static content for the /for-agents page. Designer renders; content edits
// happen here. Kept in code (not a CMS) because the data is small and stable.

export type McpConfig = {
  target: string;
  label: string;
  description: string;
  config: string;
};

export const MCP_CONFIGS: McpConfig[] = [
  {
    target: "claude-desktop",
    label: "Claude Desktop",
    description:
      "Add the Cardo MCP server to your `claude_desktop_config.json`. Restart Claude after saving.",
    config: `{
  "mcpServers": {
    "cardo": {
      "url": "https://mcp.rome.builders",
      "headers": {
        "X-Rome-Client-Kind": "agent"
      }
    }
  }
}`,
  },
  {
    target: "cursor",
    label: "Cursor",
    description:
      "Add to Cursor's MCP settings (Settings → MCP) — same shape as Claude Desktop.",
    config: `{
  "mcpServers": {
    "cardo": {
      "url": "https://mcp.rome.builders",
      "headers": {
        "X-Rome-Client-Kind": "agent"
      }
    }
  }
}`,
  },
  {
    target: "continue",
    label: "Continue.dev",
    description:
      "Stdio-based clients connect through the MCP proxy shim. See Continue's docs for the exact config.json placement.",
    config: `{
  "mcpServers": [
    {
      "name": "cardo",
      "transport": {
        "type": "http",
        "url": "https://mcp.rome.builders"
      }
    }
  ]
}`,
  },
];
