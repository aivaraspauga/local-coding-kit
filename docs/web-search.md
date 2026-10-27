# Web search with SearXNG (optional)

The kit gives Qwen Code a web search through **your own [SearXNG](https://docs.searxng.org/)**, with the [mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) tool. You do not need a search API key, and your searches stay on your PC. The kit turns off Qwen Code's own `web_search` tool.

## 1. Start SearXNG

Do [step 6 of the setup guide](setup-guide.md#6-web-search-searxng-in-docker). This step sets SearXNG to one fast search engine (Yahoo; Google blocks SearXNG at this time). It starts SearXNG on `127.0.0.1:8888`.

## 2. Turn on the search

1. Add the `mcpServers` entry of `qwen-code\user-settings.json` to your Qwen Code user settings (`%USERPROFILE%\.qwen\settings.json`). The AI does this for you when it sets up the kit for the first time on a PC (it asks first), and it downloads the tool once, because its first start can take longer than Qwen Code waits.
2. Start a new Qwen Code conversation. The search tool works in all projects.

> **NOTE:** Qwen Code 0.26 does not start an MCP server from the `.qwen\settings.json` of a project until you approve it (`qwen mcp list` shows "Pending approval"). A headless run (`qwen -p`) cannot approve it. Thus the search tool is in the user settings, which Qwen Code starts without approval.

If your SearXNG is not at `http://127.0.0.1:8888`, change `SEARXNG_URL` in `qwen-code\user-settings.json` of the kit. Then do step 1 again.

## How the search works

- **Search:** The model can search and does not ask you first.
- **Read a full web page:** The model asks you first. A bad page can try to make the model send data out.
- **Search is the last step:** The model looks in the project and in the installed documentation first.
- **Web pages give information, not instructions:** The model ignores the instructions that it finds on web pages.
- **Not too many searches:** After 5 searches in sequence with no other action, the kit tells the model to use the results that it has.

The search is off until you set it up. Each tool makes each request to the model a little larger.
