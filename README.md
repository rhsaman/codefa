# Codefa

A production-ready Electron desktop coding assistant with multi-provider LLM support and a Pydantic AI agent that can read, write and search files in a sandboxed project folder.

## Features

- **Multi-provider LLM** — OpenRouter, any OpenAI-compatible API (llama.cpp / vLLM), and local Ollama — all through Pydantic AI.
- **Dynamic model switching** — models are fetched from the active provider and selectable from the UI.
- **Two agent modes** — `Chat` (conversational coding assistant) and `Code Writer` (autonomous code-writing agent). Toggle at the top of the chat panel or with `Cmd/Ctrl+M`.
- **Tool-based agent** — `read_file`, `write_file`, `list_files`, `search_in_files` executed by the Pydantic AI sidecar, constrained to the project root.
- **Safe file access** — pick a project folder; every read/write/search is confined to it (path-traversal and symlink-escape guards in both Electron IPC and Python).
- **UI** — resizable file explorer (left), Monaco editor (center), streaming AI chat with markdown + syntax highlighting (right).
- **RTL / LTR** — chat messages use `direction: auto; unicode-bidi: plaintext` so Persian + English mix correctly.
- **Streaming** — token-by-token SSE streaming from the sidecar, no terminal output.
- **Persistence** — provider config and chat history stored in `~/.coder/`.
- **Bonus** — model caching, multiple chats, dark/light theme, keyboard shortcuts.

## Requirements

- Node.js >= 20 and npm
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Python >= 3.10 (managed by uv)

## Setup

```bash
npm install       # JS dependencies
npm run setup     # creates backend/.venv and installs pydantic-ai, fastapi, uvicorn
```

## Development

```bash
npm run dev
```

Opens the Electron window with a hot-reloading renderer. The Python sidecar (FastAPI + Pydantic AI) is auto-spawned on an ephemeral localhost port.

## Building / packaging

```bash
npm run build       # typecheck + build renderer, main and preload
npm run dist        # package for the current OS (dmg/zip on mac, NSIS exe on win, AppImage on linux)
npm run dist:mac    # only macOS
npm run dist:win    # only Windows
npm run dist:linux  # only Linux
```

Output lands in `release/`.

## Usage

1. Click **Open Folder** (or `Cmd/Ctrl+O`) and select your project root.
2. Open settings (`Cmd/Ctrl+,`). The default provider is **opencode** (`opencode/deepseek-v4-flash-free` via OpenRouter). You can switch to OpenRouter, a custom OpenAI-compatible API, or a local endpoint (Ollama / llama.cpp / vLLM), enter your API key / base URL, and pick a model.
3. Choose an agent mode: **Chat** or **Code Writer**.
4. Type a message and press `Cmd/Ctrl+Enter`. The agent streams its reply and uses sandboxed tools to inspect or modify files.

## Keyboard shortcuts

| Shortcut         | Action                                             |
| ---------------- | -------------------------------------------------- |
| `Cmd/Ctrl+Enter` | Send chat message                                  |
| `Cmd/Ctrl+M`     | Toggle agent mode (Chat / Code Writer)             |
| `Cmd/Ctrl+P`     | Quick-open / search overlay (⌘⇧F for content grep) |
| `Cmd/Ctrl+B`     | Toggle sidebar                                     |
| `Cmd/Ctrl+,`     | Open settings                                      |
| `Cmd/Ctrl+S`     | Save current file                                  |
| `Cmd/Ctrl+T`     | New chat                                           |

## Architecture

```
┌──────────────── Electron ────────────────┐
│ main.ts   window, sidecar spawn, fs IPC, │
│           config + chat persistence      │
│ preload.ts contextBridge (whitelisted)   │
│ renderer  React + Monaco + chat (SSE)    │
└─────┬──────────────────▲─────────────────┘
      │ spawn / stdio     │ HTTP + SSE (127.0.0.1)
┌─────▼──────────────────┴─────────────────┐
│ Python sidecar  (uv managed .venv)        │
│ server.py   FastAPI  /health /models     │
│             /chat/stream (SSE) /fs        │
│ providers.py → pydantic-ai OpenAIModel    │
│ tools.py    sandboxed fs tools            │
│ agents.py   Chat / Code Writer agents     │
└───────────────────────────────────────────┘
```
