# AI Integrations

Moperator supports integration with AI assistants through two protocols:

- **OpenAPI** - For ChatGPT Custom GPTs (Actions)
- **MCP** - For Claude Desktop (Model Context Protocol)

## ChatGPT Integration (OpenAPI)

ChatGPT can access your Moperator inbox through Custom GPT Actions using the OpenAPI spec.

### Setup Steps

1. **Get your API key**

   After creating a tenant, you'll receive an API key in the format `mop_xxx_yyy`.

2. **Create a Custom GPT**

   - Go to [ChatGPT](https://chat.openai.com) → Explore GPTs → Create
   - Give your GPT a name like "My Email Assistant"

3. **Configure Actions**

   In the GPT editor, click "Create new action" and:

   - **Import from URL**: `https://moperator.raullenchai.workers.dev/openapi.json`
     (Replace with your Moperator deployment URL)

   - **Authentication**: Select "API Key"
     - Auth Type: Bearer
     - API Key: Your Moperator API key (`mop_xxx_yyy`)

4. **Save and Test**

   Ask your GPT: "Show me my recent emails" or "Check my inbox"

### Available Actions

| Action | Description |
|--------|-------------|
| `listEmails` | List recent emails with pagination |
| `searchEmails` | Search by sender or subject |
| `getEmail` | Get full email details by ID |
| `getEmailStats` | Get inbox statistics |

### Tips for Better Results

- The OpenAPI descriptions include instructions for ChatGPT to display all emails as a list
- Email bodies are truncated to 200 chars in list view to avoid response size limits
- Use `searchEmails` to find specific emails by sender or subject

---

## Claude Desktop Integration (MCP)

Claude Desktop can access your Moperator inbox through the Model Context Protocol (MCP).

### Setup Steps

1. **Create the bridge script**

   Create a file at `~/.mcp-servers/moperator-bridge.js`:

   ```javascript
   #!/usr/bin/env node

   const https = require('https');

   const MCP_URL = 'https://moperator.raullenchai.workers.dev/mcp';
   const API_KEY = 'YOUR_API_KEY_HERE';  // Replace with your mop_xxx_yyy key

   let buffer = '';

   process.stdin.setEncoding('utf8');
   process.stdin.on('data', (chunk) => {
     buffer += chunk;

     let newlineIndex;
     while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
       const line = buffer.slice(0, newlineIndex);
       buffer = buffer.slice(newlineIndex + 1);
       if (line.trim()) handleLine(line);
     }
   });

   async function handleLine(line) {
     try {
       const request = JSON.parse(line);
       if (request.method && !('id' in request)) return; // Skip notifications

       const response = await makeRequest(request);
       process.stdout.write(JSON.stringify(response) + '\n');
     } catch (err) {
       process.stdout.write(JSON.stringify({
         jsonrpc: '2.0',
         id: null,
         error: { code: -32700, message: err.message }
       }) + '\n');
     }
   }

   function makeRequest(body) {
     return new Promise((resolve, reject) => {
       const postData = JSON.stringify(body);
       const req = https.request({
         hostname: 'moperator.raullenchai.workers.dev',  // Replace with your deployment
         path: '/mcp',
         method: 'POST',
         headers: {
           'Content-Type': 'application/json',
           'Authorization': `Bearer ${API_KEY}`,
           'Content-Length': Buffer.byteLength(postData)
         }
       }, (res) => {
         let data = '';
         res.on('data', chunk => data += chunk);
         res.on('end', () => {
           try { resolve(JSON.parse(data)); }
           catch (e) { reject(new Error('Invalid JSON response')); }
         });
       });
       req.on('error', reject);
       req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
       req.write(postData);
       req.end();
     });
   }

   process.stdin.resume();
   ```

2. **Configure Claude Desktop**

   Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "moperator": {
         "command": "node",
         "args": ["/Users/YOUR_USERNAME/.mcp-servers/moperator-bridge.js"]
       }
     }
   }
   ```

   Replace `YOUR_USERNAME` with your actual username.

3. **Restart Claude Desktop**

   Quit Claude Desktop completely (Cmd+Q) and reopen it.

4. **Verify Connection**

   - Click the plug icon in Claude Desktop
   - Check that "moperator" shows as connected
   - If it shows "failed", check the logs at `~/Library/Logs/Claude/mcp-server-moperator.log`

5. **Test**

   Ask Claude: "Check my email" or "How many emails do I have?"

### Available Tools

| Tool | Description |
|------|-------------|
| `check_inbox` | List recent emails in your inbox |
| `read_email` | Read full content of a specific email |
| `search_emails` | Search by sender or subject |
| `email_stats` | Get inbox statistics |

### Troubleshooting

**"Server disconnected" error**

- Check that the bridge script path is correct
- Verify your API key is valid
- Check logs at `~/Library/Logs/Claude/mcp-server-moperator.log`

**Claude doesn't use the tools**

- Try asking explicitly: "use the check_inbox tool to see my emails"
- The tool descriptions guide Claude on when to use them

**Request timeout**

- The bridge has a 30-second timeout for API requests
- Check your network connection
- Verify the Moperator server is accessible

---

## Protocol Comparison

| Feature | ChatGPT (OpenAPI) | Claude Desktop (MCP) |
|---------|-------------------|----------------------|
| Setup | Import URL in Actions | Local bridge script |
| Auth | Bearer token in GPT config | API key in bridge script |
| Format | REST API with JSON | JSON-RPC over stdio |
| Response | Structured JSON | Human-readable text |
| Best for | GPT Actions, web UI | Desktop app, local use |

Both protocols provide the same core functionality - listing, reading, and searching emails.
