"""Pydantic AI agents for the two UI modes.

* ``chat``      -> conversational coding assistant (conservative tool use)
* ``codewriter``-> autonomous code-writing agent (proactive tool use)

Tools are registered per-run, bound to the sandboxed ROOT, and emit live
activity events that the server forwards over SSE so the UI can render tool
calls as they happen.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import tempfile
import warnings
from collections.abc import AsyncIterator
from typing import Any

warnings.filterwarnings(
    "ignore",
    message="Sampling parameters.*reasoning",
    category=UserWarning,
)

import yaml
from fastmcp.client.transports import StdioTransport
from pydantic_ai import Agent, AgentRunResultEvent, RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.mcp import MCPToolset, load_mcp_toolsets
from pydantic_ai.toolsets import PrefixedToolset
from pydantic_ai.messages import (
    ImageUrl,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    SystemPromptPart,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    UserPromptPart,
)
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import Tool
from httpx import Timeout

from providers import build_model
from tools import (
    PathEscapeError,
    _is_text_path,
    _read_text,
    list_files,
    make_tool_callbacks,
    read_file,
    resolve_safe,
    user_coder_dir,
)

SYSTEM_PROMPTS: dict[str, str] = {
    "chat": "You are Coder, a friendly and highly capable coding assistant embedded in a desktop IDE. You answer questions, explain code, suggest fixes and help the user understand their project. Before answering ANY question that could relate to the user's project in any way (behavior, styling, colors, config, logic, bugs, file structure, dependencies, etc.), you MUST first use the file tools (read_file, list_files, search_in_files) to inspect the actually relevant files in the workspace — do NOT answer from general/generic knowledge alone if the answer could depend on the real project files. To keep context use low on large files: prefer search_in_files (optionally with a small `context` for lines around a match) and read_lines to read only the needed line range, falling back to read_file only for small files or when you need the whole file. When you only remember part of a filename, use fuzzy_find to locate the file by name. When the answer needs current or external information (library versions, docs, APIs, error fixes, news), use web_search to fetch up-to-date results. When you need to read the actual content of a specific web page (e.g. a service's docs, a tool's website, an MCP server's page), use fetch_url to retrieve its text. Only skip the file tools for questions that are clearly unrelated to this specific project — e.g. domain/website availability checks (like 'is X.com free?'), general knowledge, web research, or plain greetings. For such unrelated questions do NOT call list_files or any file tool; answer directly, or use web_search / fetch_url, or an MCP tool if one is loaded (e.g. a domain-check server). When the user @mentions a file, that file's full content is ALREADY in your context — do NOT call list_files or a workspace-wide search_in_files for it; if you need to find something, call search_in_files with that file's path so only that file is searched, or read_lines on it directly. Use the plain relative path without the '@' and without a leading slash. Use list_files / search_in_files across the workspace ONLY when no file is mentioned and you genuinely need to locate something. If you have not looked at the relevant files yet for a project-related question, look first, then answer. You can edit and manage the app's own configuration: when the user asks to add, install, create or save a reusable SKILL or prompt recipe, use create_skill (writes ~/.coder/skills/<slug>/SKILL.md with frontmatter so it is indexed automatically). When the user asks to add or set up an MCP server / connector / integration, use create_mcp with the connector's command or URL (it persists to ~/.coder/mcp.json and loads on the next message). For skill or MCP requests, do NOT search or list the workspace first — call create_skill / create_mcp directly; research the target service with web_search / fetch_url only if you actually need details to fill them in. Use the memory tool (action=add/replace/remove) to keep a durable note about THIS project when you learn something worth remembering — a convention, a gotcha, a fix that worked, a preference the user mentioned in passing — so future sessions already know it; keep it concise, prefer replace/remove over piling up new adds, and never store secrets, credentials or anything already in AGENTS.md. Memory is NOT pre-loaded into your context — call search_memory with a few keywords whenever past notes might help (start of non-trivial work, something that sounds familiar, a recurring error). You CANNOT modify, create or delete project source files and you cannot run terminal commands — write_file, edit_file and run_terminal do not exist in this mode. Never claim that you created, wrote, modified or deleted a project file, and never claim an operation succeeded if you could not actually perform it. When the user asks to create or change a project file, respond honestly: say you cannot in Chat mode, name the exact relative path (e.g. 'a.md'), and tell them to switch to Code Writer mode to apply it. Guide them like a mentor: explain in plain words what needs to change and why. Never show tool-call syntax in code blocks (no read_file(...)/write_file(...)) and never invent tool names — describe actions in plain words. When the user references a file with an @mention, the file's content is already in your context; if you need a tool, use its plain relative path without the '@' and without a leading slash. Do not paste a file's full contents into your reply unless the user explicitly asks — refer to the file by its path instead. Always match the user's language: if they write in Persian, answer entirely in Persian; if they write in English, answer in English. Keep the same language for the rest of the conversation.",
    "codewriter": "You are Coder, an autonomous code-writing agent working inside a desktop IDE. When the user requests a feature, task or fix you plan, scout the relevant files, then implement it end-to-end by writing or editing files with your tools. Be proactive: use read_file, list_files and search_in_files to understand the project before writing. To keep context use low on large files, prefer search_in_files (optionally with a small `context`) and read_lines for targeted reads, reserving read_file for small files or whole-file needs. Use fuzzy_find when you only remember part of a filename, and use run_terminal to build, test, lint, install dependencies or run other project commands. When the user @mentions a file or files, that file's full content is ALREADY in your context — do NOT run a workspace-wide search for it; if you need to find something within them, call search_in_files with that file's path so only those files are searched. Use workspace-wide list_files / search_in_files only when no file is mentioned and you genuinely need to locate something. When you need current or external information (library versions, docs, APIs, error fixes), use web_search to fetch up-to-date results instead of guessing, and use fetch_url to read the actual content of a specific web page (e.g. docs, a service's site). For ANY change to an EXISTING file, prefer edit_file: pass the exact old_string (with enough surrounding context to make it unique) and the new_string to replace it with — this preserves the rest of the file automatically and is far cheaper than resending the whole file. Only use write_file for brand-new files or when the user explicitly wants a full rewrite; if you do use write_file on an existing file, you MUST read it first and write back the complete content (existing content plus your changes), never a partial file. When the user asks to add, install, create or save a reusable SKILL or prompt recipe, use create_skill directly (it writes ~/.coder/skills/<slug>/SKILL.md with frontmatter so the skill is indexed automatically). When the user asks to add or set up an MCP server / connector / integration (e.g. filesystem, database, a tool server), use create_mcp directly with the connector's command or URL — it persists to ~/.coder/mcp.json and loads on the next message. For skill or MCP requests, do NOT search or list the workspace first — call create_skill / create_mcp immediately; use web_search / fetch_url only to research the target service if you need details (e.g. the right package name or URL). Use the memory tool (action=add/replace/remove) to keep a durable note about THIS project when you learn something worth remembering — a convention, a gotcha, a fix that worked, a preference the user mentioned in passing — so future sessions already know it; keep it concise, prefer replace/remove over piling up new adds, and never store secrets, credentials or anything already in AGENTS.md. Memory is NOT pre-loaded into your context — call search_memory with a few keywords whenever past notes might help (start of non-trivial work, something that sounds familiar, a recurring error). Always match the user's language: if they write in Persian, answer entirely in Persian; if they write in English, answer in English. Keep the same language for the rest of the conversation. After finishing, summarize in the user's language what you changed, the files you touched, and anything the user must do next (e.g. run a command). Keep prose minimal and focused on the implementation. If the request is a question rather than a task, answer it directly.",
}

MODEL_SETTINGS: dict[str, ModelSettings] = {
    "chat": ModelSettings(temperature=0.4),
    "codewriter": ModelSettings(temperature=0.2),
}

# Thinking levels the UI can select. '' = provider default, 'none' = reasoning
# disabled, the rest map to increasingly deeper reasoning effort. Setting a low
# level (or 'none') is the most effective way to keep a reasoning model from
# flooding a small context window with thinking tokens and getting cut off.
_THINKING_LEVELS = {
    "": None,
    "none": False,
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
}


# Cloud gateways that expose reasoning-capable models. Local adapters (ollama,
# and llama.cpp/vLLM/LM Studio via `custom`) usually can't honor a reasoning
# effort, so for them we never auto-inject a `thinking` value — that avoids both
# a stray `reasoning_effort` param and silent context burn on local models.
_CLOUD_AUTO_THINK_PROVIDERS = {"opencode", "openrouter"}


def _settings_for(
    mode: str, ctx: int, thinking_level: str = "", provider: str = ""
) -> ModelSettings:
    """Model settings tuned to the mode, provider and the model's context window.

    Small windows get a capped output so a single reasoning response plus the
    tool-loop re-sends stay inside the window. A context-based ``thinking`` level
    is applied automatically only for cloud gateways; local providers get no
    explicit ``thinking`` (they usually can't honor it). An explicit user
    ``thinking_level`` always overrides.
    """
    base: dict[str, Any] = dict(MODEL_SETTINGS.get(mode, MODEL_SETTINGS["chat"]))
    if ctx > 0:
        base["max_tokens"] = max(1_024, ctx // 4)
    if ctx > 0 and provider in _CLOUD_AUTO_THINK_PROVIDERS:
        if ctx <= 16_000:
            base["thinking"] = "low"
        elif ctx <= 64_000:
            base["thinking"] = "medium"
    level = _THINKING_LEVELS.get((thinking_level or "").strip())
    if level is not None:
        base["thinking"] = level
    # Bound every model request so a stalled provider connection can't hang the
    # stream for minutes (pydantic-ai's default HTTP timeout is 600s). A read
    # timeout here turns a dead connection into a retryable error quickly and
    # guarantees the whole run finishes instead of freezing the UI.
    base["timeout"] = Timeout(90, connect=15, read=90)
    return base

# Model requests that hit a transient 429 / 5xx are retried with backoff so a
# single rate-limit blip on a provider doesn't kill a long tool-heavy task.
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
_RETRIES = 3
_RETRY_BASE_SECONDS = 1.5
_RETRYABLE_PHRASES = (
    "rate limit",
    "ratelimit",
    "timeout",
    "timed out",
    "connection reset",
    "connection aborted",
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "overloaded",
)


def _is_retryable(exc: BaseException) -> bool:
    """Best-effort check for whether ``exc`` looks like a transient provider
    error worth retrying (429 / 5xx / connection blips) rather than a hard
    failure (bad API key, invalid model, bad request) that would just fail
    identically on retry.
    """
    text = str(exc)
    status_match = re.search(r"status[_ ]code[:=]?\s*(\d{3})", text, re.IGNORECASE)
    if status_match:
        try:
            return int(status_match.group(1)) in _RETRYABLE_STATUS
        except ValueError:
            pass
    for code in _RETRYABLE_STATUS:
        if re.search(rf"(?<!\d){code}(?!\d)", text):
            return True
    low = text.lower()
    return any(phrase in low for phrase in _RETRYABLE_PHRASES)

# When the provider doesn't advertise a context window, assume a conservative
# size so tool-output budgeting still kicks in (prevents runaway token burn on
# small free models).
DEFAULT_CONTEXT_WINDOW = 32_000


def _to_model_messages(history: list[dict]) -> list[ModelMessage]:
    """Convert plain {role, content} turns to pydantic-ai messages."""
    messages: list[ModelMessage] = []
    for turn in history:
        role = turn.get("role", "user")
        content = str(turn.get("content", ""))
        if role == "system":
            messages.append(ModelRequest(parts=[SystemPromptPart(content=content)]))
        elif role == "assistant":
            messages.append(ModelResponse(parts=[TextPart(content=content)]))
        elif role == "user":
            messages.append(ModelRequest(parts=[UserPromptPart(content=content)]))
    return messages


def _event_delta(text: str) -> dict:
    return {"kind": "text", "content": text}


def _tool_event(ev: dict) -> dict:
    kind = ev.get("kind", "tool_result")
    if kind not in ("tool", "tool_result", "diff"):
        kind = "tool_result"
    out: dict = {"kind": kind, "tool": ev.get("tool", "")}
    for key in ("args", "summary", "path", "diff", "content"):
        val = ev.get(key)
        if val is not None:
            out[key] = val
    return out


def _usage_event(usage) -> dict | None:
    """
    Extracts usage statistics from the Pydantic AI result with robust fallback.
    Handles different attribute names used by various LLM providers.
    """
    if not usage:
        return None

    try:
        # 1. تلاش برای استخراج با نام‌های استاندارد pydantic-ai
        input_tokens = getattr(usage, "input_tokens", 0)
        output_tokens = getattr(usage, "output_tokens", 0)
        cache_read_tokens = getattr(usage, "cache_read_tokens", 0)
        cache_write_tokens = getattr(usage, "cache_write_tokens", 0)

        # 2. اگر مقادیر صفر بودند، تلاش برای استخراج از نام‌های رایج در OpenAI/OpenRouter
        if not input_tokens and not output_tokens:
            input_tokens = getattr(usage, "prompt_tokens", 0)
            output_tokens = getattr(usage, "completion_tokens", 0)

            # اگر باز هم صفر بود، سعی می‌کنیم از دیکشنری استفاده کنیم (اگر usage دیکشنری باشد)
            if isinstance(usage, dict):
                input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
                output_tokens = usage.get(
                    "completion_tokens", usage.get("output_tokens", 0)
                )

        # 3. کل واقعی = total_tokens معادل pydantic-ai یعنی input + output.
        #    نکته مهم: input_tokens در pydantic-ai ALREADY شامل cache_read/cache_write
        #    است، بنابراین cache را جدا اضافه نمی‌کنیم تا عدد دو بار نشمارده نشود
        #    (کاملاً منطبق با مستندات pydantic-ai و رویه‌ی opencode).
        total_tokens = int(input_tokens) + int(output_tokens)

        # 4. اطمینان از اینکه خروجی حتماً عدد صحیح (int) است
        return {
            "kind": "usage",
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "total_tokens": total_tokens,
            "cache_read_tokens": int(cache_read_tokens),
            "cache_write_tokens": int(cache_write_tokens),
        }
    except Exception as e:
        # در صورت بروز هرگونه خطا، برای جلوگیری از کرش کردن برنامه، مقدار صفر برگردانده می‌شود
        print(f"Error parsing usage in agents.py: {e}")
        return None


# Fraction of the model's context window at which we choose to compact BEFORE an
# overflow: once a request's true input tokens (reported by the provider) pass
# this share of the window, the in-flight tool loop is stopped and the turn is
# re-sent from compacted history instead of waiting to hit the hard limit. This
# keeps small-context models (8k) from dying with
# `request (N tokens) exceeds the available context size (M tokens)`.
_PREEMPTIVE_COMPACT_FRACTION = 0.8


class _HighWatermark(Exception):
    """Raised when a single request's input tokens fill too much of the window.

    Carries the measured token total so the auto-compact branch can surface it as
    a compact + usage event (mirroring the overflow path) instead of a raw error.
    """

    def __init__(self, tokens: int, limit: int) -> None:
        super().__init__(f"approaching context limit: {tokens} of {limit} tokens")
        self.tokens = tokens
        self.limit = limit


class _UsageCapability(AbstractCapability[Any]):
    """Reports per-request token usage from the provider in real time.

    Every model request inside the tool loop ends with an `after_model_request`
    callback carrying that request's `ModelResponse.usage` — the SAME number the
    provider counts against the context limit (this is exactly what overflows as
    `request (N tokens) exceeds the available context size`). Forwarding each one
    to the queue (a) drives an accurate live context meter with zero estimation
    and (b) lets us compact pre-emptively when a request is about to overflow.
    """

    def __init__(
        self,
        on_usage,
        context_limit: int,
        state: dict,
    ) -> None:
        self._on_usage = on_usage
        self._context_limit = context_limit
        self._state = state

    async def after_model_request(  # noqa: N805
        self,
        ctx: RunContext,
        *,
        request_context,
        response: ModelResponse,
    ) -> ModelResponse:
        usage = _usage_event(getattr(response, "usage", None))
        if usage and self._on_usage is not None:
            try:
                self._on_usage(usage)
            except Exception:  # noqa: BLE001
                pass
        if self._context_limit > 0:
            total = usage.get("input_tokens", 0) if usage else 0
            self._state["last"] = total
            if total >= int(self._context_limit * _PREEMPTIVE_COMPACT_FRACTION):
                self._state["hit"] = True
        return response  # noqa: RET504


_AUTO_SCOUT_KEY_FILES = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "Gemfile",
    "README.md",
    "readme.md",
    "Pipfile",
    "Makefile",
]

# Persistent per-project instructions file, checked in this order at the
# project root (mirrors the emerging AGENTS.md convention shared by several
# coding agents, plus a Coder-specific fallback location). Unlike the
# auto-scouted key files above (which are budget-limited and can be dropped
# entirely for small-context models), this is always included in full — up to
# a generous cap — because it holds durable user preferences (conventions,
# commands to run, things to always/never do) that shouldn't be silently
# dropped just because the model has a small window.
_PROJECT_MEMORY_FILES = ["AGENTS.md", ".coder/AGENTS.md"]
_PROJECT_MEMORY_MAX_BYTES = 12_000


def _load_project_memory(root: str) -> str:
    """Read the project's persistent instructions file, if present.

    Returns a ready-to-append system-prompt section, or ``""`` if no such file
    exists. Never raises — a missing or unreadable file just yields nothing.
    """
    for rel in _PROJECT_MEMORY_FILES:
        try:
            result = read_file(root, rel)
        except Exception:  # noqa: BLE001
            continue
        if not result or "content" not in result:
            continue
        body = result["content"].strip()
        if not body:
            continue
        if len(body) > _PROJECT_MEMORY_MAX_BYTES:
            body = (
                body[:_PROJECT_MEMORY_MAX_BYTES]
                + "\n…(truncated — file exceeds the auto-included limit; read the "
                "rest with read_file if needed)"
            )
        return (
            f"\n\n===== PROJECT MEMORY ({rel}) =====\n"
            "The project owner left these persistent instructions. Follow them for "
            "every request in this project unless the user explicitly overrides one "
            "in the current message.\n"
            f"{body}\n"
            "===== END PROJECT MEMORY ====="
        )
    return ""


# The agent's OWN self-written memory (distinct from the user-authored AGENTS.md
# above). Curated via the `memory` tool (add/replace/remove; see tools.py) as
# the agent works, so a later session in the same project starts already
# knowing things it learned before — conventions it discovered, gotchas, fixes
# that worked. The file can now hold many notes (tools.LEARNED_MEMORY_MAX_BYTES),
# so instead of inlining its full content into every system prompt (which used
# to cap it artificially small), we only tell the model how many notes exist
# and point it at the `search_memory` tool to retrieve just what's relevant.
_LEARNED_MEMORY_FILE = ".coder/MEMORY.md"


def _load_learned_memory(root: str) -> str:
    """Point the model at its own memory instead of dumping it into every prompt.

    Returns a short pointer naming how many notes exist, or ``""`` if none have
    been saved yet. Never raises.
    """
    try:
        result = read_file(root, _LEARNED_MEMORY_FILE)
    except Exception:  # noqa: BLE001
        return ""
    if not result or "content" not in result:
        return ""
    count = sum(1 for ln in result["content"].splitlines() if ln.strip().startswith("- "))
    if count == 0:
        return ""
    return (
        f"\n\n===== YOUR OWN MEMORY ({_LEARNED_MEMORY_FILE}) =====\n"
        f"You have {count} saved note{'s' if count != 1 else ''} from earlier sessions on this "
        "project (added yourself via the memory tool): conventions you discovered, gotchas, fixes "
        "that worked, preferences the user mentioned in passing. They are NOT loaded here — call "
        "search_memory with a few keywords whenever they might help: at the start of non-trivial "
        "work, when the request sounds like something covered before, or when you hit a recurring "
        "error. If nothing relevant turns up, proceed normally.\n"
        "===== END YOUR OWN MEMORY ====="
    )


# Conservative defaults so even small-context local models (e.g. 8k) fit.
# Larger context windows unlock richer scouting (see run_agent).
_AUTO_SCOUT_MAX_KEY_BYTES = 6_000
_AUTO_SCOUT_MAX_TOTAL = 8_000


def _needs_workspace(prompt: str) -> bool:
    """Structural heuristic for when auto-scouting is worth doing.

    Workspace scouting only helps when the user's request is about the project.
    We skip it for turns that are clearly external or trivial — no keyword lists,
    just shape:

    * contains a host/domain / URL / IP (a web, availability or whois lookup);
    * is a very short message (greeting, punctuation like "?", one-liner).

    File paths (src/main.py) and code identifiers are NOT treated as domains, so
    real project work still gets the overview.
    """
    try:
        text = prompt.strip()
    except AttributeError:
        return False
    if not text:
        return False

    if len(text) <= 8:
        return False

    # Host/domain/IP tokens. Each whitespace token is checked standalone:
    #   - scheme://host… URLs,
    #   - host:port (e.g. localhost:1234, 127.0.0.1:8000),
    #   - name.tld hostnames — but NOT file paths (leading "/") and NOT code
    #     identifiers that merely end in a dotted code extension (x.py, y.ts).
    # Common code file extensions are excluded from the "tld" match.
    code_exts = {
        "py", "ts", "tsx", "js", "jsx", "css", "json", "md", "html", "htm",
        "go", "rs", "rb", "java", "c", "h", "cpp", "hpp", "cs", "php", "vue",
        "sh", "toml", "yml", "yaml", "ini", "sql", "txt", "map", "d.ts",
    }
    for tok in re.split(r"\s+", text):
        low = tok.lower()
        if re.match(r"https?://", low):
            return False
        if re.match(r"localhost:\d+$", low):
            return False
        if re.match(r"^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$", low):
            return False
        if low.startswith("/") or low.startswith("./") or low.startswith("../"):
            continue  # file path
        m = re.match(r"^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.([a-z]{2,6})$", low)
        if m and m.group(2) not in code_exts:
            return False

    return True


def _scout_workspace(root: str, max_total: int = _AUTO_SCOUT_MAX_TOTAL) -> str:
    """Build a compact workspace overview (root listing + small key files) so weak
    models see the project even if they never call the file tools.

    The listing reuses ``list_files``/``read_file`` (already sandboxed to root);
    any error is swallowed so scouting is purely additive. ``max_total`` caps the
    total encoded size so it never overflows a small model's context window.
    """
    try:
        listing = list_files(root, "")
    except Exception:  # noqa: BLE001
        listing = {}
    lines: list[str] = []
    lines.append(
        "=== AUTO-SCOUTED WORKSPACE OVERVIEW (do not take this as exhaustive) ==="
    )
    try:
        root_real = resolve_safe(root, "")
    except Exception:  # noqa: BLE001
        root_real = root
    if listing.get("error"):
        lines.append(f"root: {root_real}  (listing unavailable: {listing['error']})")
    else:
        entries = listing.get("entries", [])
        names = ", ".join(e["name"] for e in entries) if entries else "(empty)"
        lines.append(f"root: {root_real} — top-level entries: {names}")

    if max_total <= 0:
        return "\n".join(lines)

    header = len("\n".join(lines)) + 24
    total = 0
    for key in _AUTO_SCOUT_KEY_FILES:
        try:
            result = read_file(root, key)
        except Exception:  # noqa: BLE001
            continue
        if not result or "content" not in result:
            continue
        body = result["content"]
        # Cap a single file and the cumulative budget.
        budget = min(_AUTO_SCOUT_MAX_KEY_BYTES, max_total - header - total)
        if budget <= 0:
            break
        if len(body) > budget:
            body = body[:budget] + "\n…(truncated)"
        lines.append(f"\n### {key} (auto-scouted)\n{body}")
        total += len(body)
        if total >= max_total - header:
            break
    return "\n".join(lines)


def _fit_history(history: list[dict], budget_chars: int) -> list[dict]:
    """Trim prior turns to ``budget_chars`` characters, keeping the most recent.

    Pydantic-ai re-sends the full history on every model request inside the tool
    loop, so keeping the history bounded is the single biggest lever for making
    small-context models (8k) finish without overflowing.
    """
    if budget_chars <= 0:
        return []
    total = sum(len(str(t.get("content", ""))) for t in history)
    if total <= budget_chars:
        return history
    kept: list[dict] = []
    acc = 0
    for turn in reversed(history):
        c = len(str(turn.get("content", "")))
        if acc + c > budget_chars and kept:
            break
        kept.append(turn)
        acc += c
    return list(reversed(kept))


def _history_budget(ctx: int, system_text: str, scouted: str) -> int:
    """Char budget for the history given the model's context window.

    Rough char/token ratio of 4. For small windows we reserve a large slice for
    the in-run growth (tool-loop re-sends, thinking, reply), so history gets a
    smaller share; big windows can afford more.
    """
    if ctx <= 0:
        return 240_000
    base_chars = len(system_text) + len(scouted or "")
    if ctx <= 16_000:
        share = 0.30
        floor = 800
    elif ctx <= 64_000:
        share = 0.45
        floor = 2_000
    else:
        share = 0.60
        floor = 4_000
    return max(floor, int(ctx * 4 * share) - base_chars)


def _is_context_overflow(exc: BaseException) -> bool:
    """Best-effort detection of a "context window is full" model error.

    Providers report this in varied wording (context_length_exceeded, "prompt
    is too long", "exceeded the context", "token limit", "exceeds available
    context size" ...). This is NOT a transient blip to backoff-and-retry; it
    means the request itself is too big to complete, so the only way to
    continue is to compact first.

    Instead of an exhaustive phrase whitelist (which misses the long tail of
    provider wordings), we look for a context/token concept COMBINED with an
    exhaustion signal ("exceed/exceeds/exceeded", "too long/large", "limit",
    "available size", "increase", ...). Missing either side → not a context
    overflow.
    """
    low = str(exc).lower()
    if not any(k in low for k in ("context", "token")):
        return False

    # Exhaustion signals — stop early on generic long strings that merely
    # mention the word "context" but aren't an overflow (e.g. we don't want a
    # normal "watch the context" instruction matched).
    signals = (
        "exceed",
        "too long",
        "too large",
        "too many",
        "maximum context",
        "max context",
        "context length",
        "context window",
        "context_limit",
        "context_size",
        "available context size",
        "token limit",
        "token_limit",
        "reduce the length",
        "reducing available tokens",
        "window is too small",
        "increase it",
        "try reducing",
        "please reduce",
        "needs to be smaller",
        "truncat",
    )
    return any(s in low for s in signals)


def _overflow_tokens(exc: BaseException) -> int | None:
    """Extract the token count from an overflow error message like
    ``request (9253 tokens) exceeds the available context size (8192 tokens)``.

    Used to report an accurate context meter even when the request was
    rejected before the provider returned real usage.
    """
    text = str(exc)
    m = re.search(r"(\d{1,3}(?:,\d{3})*|\d+)\s+tokens", text, re.IGNORECASE)
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


async def _compact_history(
    model: Any, history: list[dict], max_chars: int = 30_000
) -> list[dict]:
    """Collapse older turns into one short summary note, keeping the most recent
    turns verbatim, so a full window can continue instead of being cut off.

    Returns a new, smaller history. Falls back to dropping the older turns (no
    summary) if the summarizing call itself fails.
    """
    recent = history[-8:]
    older = history[:-8]
    if not older:
        return None

    text = "\n\n".join(str(t.get("content", "")) for t in older)
    if len(text) > max_chars:
        text = text[-max_chars:] + "\n...(older part omitted)"

    summary = ""
    try:
        summarizer = Agent(
            model,
            system_prompt=(
                "You are a code-session context compressor. Read the earlier "
                "conversation and write concise notes so work can continue: keep "
                "key decisions, files touched, and open questions. Under 120 words."
            ),
            model_settings=ModelSettings(temperature=0.2, max_tokens=512),
        )
        result = await summarizer.run(
            text, model_settings=ModelSettings(timeout=Timeout(60, connect=15, read=60))
        )
        summary = str(getattr(result, "output", "") or "").strip()
    except Exception:  # noqa: BLE001
        summary = ""

    compact = recent
    if summary:
        compact = [
            {"role": "system", "content": "[Compacted earlier context]\n" + summary}
        ] + recent
    return compact


def _load_skills(root: str) -> list[dict]:
    """Scan for skills and parse each SKILL.md's YAML frontmatter.

    Skills live in ``~/.coder/skills/<name>/SKILL.md`` (user-level, managed
    in-app and shared across all workspaces) plus, as a fallback, the
    workspace ``.coder/skills`` and ``.claude/skills`` (Claude Code
    convention). Each result is ``{"name", "description", "path", "content"}``;
    malformed files are skipped.
    """
    skills: list[dict] = []
    try:
        base_root = resolve_safe(root, "")
    except PathEscapeError:
        base_root = None

    scan_bases: list[tuple[str, str]] = [
        (os.path.join(user_coder_dir(), "skills"), "~/.coder/skills")
    ]
    if base_root is not None:
        for base in (".coder/skills", ".claude/skills"):
            scan_bases.append((os.path.join(base_root, base), base))

    for dirpath, display_prefix in scan_bases:
        if not os.path.isdir(dirpath):
            continue
        try:
            entries = sorted(os.listdir(dirpath))
        except OSError:
            continue
        for entry in entries:
            skill_dir = os.path.join(dirpath, entry)
            if not os.path.isdir(skill_dir):
                continue
            md = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(md):
                continue
            try:
                text, _truncated = _read_text(md)
            except OSError:
                continue
            meta: dict[str, Any] = {}
            body = text
            if text.startswith("---"):
                end = text.find("\n---", 3)
                if end != -1:
                    try:
                        parsed = yaml.safe_load(text[3:end])
                        if isinstance(parsed, dict):
                            meta = parsed
                        body = text[end + 4 :].lstrip("\n")
                    except Exception:  # noqa: BLE001
                        meta = {}
            rel = os.path.relpath(md, os.path.expanduser("~")).replace(os.sep, "/")
            skills.append(
                {
                    "name": str(meta.get("name") or entry),
                    "description": str(meta.get("description") or "").strip(),
                    "path": f"~/{rel}" if rel.startswith(".coder/") else rel,
                    "content": body.strip(),
                }
            )
    return skills


def _skills_section(skills: list[dict]) -> str:
    """Index of available skills for the system prompt.

    Workspace skills are referenced by path so the model reads them on demand
    (keeps context small). User-level skills in ``~/.coder/skills`` cannot be
    reached through the project-sandboxed read tool, so their full content is
    inlined instead, which is fine since user skills are few and small.
    """
    if not skills:
        return ""
    lines = [
        "\n\n=== AVAILABLE SKILLS ===",
        "These skills are available. If the user's request matches one, follow its "
        "instructions exactly. Content is given inline when the skill cannot be "
        "read from the workspace; otherwise read the SKILL.md file at the path shown.",
    ]
    for s in skills:
        name = s["name"]
        desc = f" — {s['description']}" if s["description"] else ""
        if s["path"].startswith("~/.coder/skills"):
            body = s["content"]
            lines.append(f"- {name}{desc} (user skill):\n{body}")
        else:
            lines.append(f"- {name}: `{s['path']}`{desc}")
    return "\n".join(lines)


def _run_mcp_config(servers: dict) -> str | None:
    """Write a run-scoped MCP config containing ONLY ``servers`` (the ones the
    UI selected for this turn) and return its path, or ``None`` if there is
    nothing to load.

    This guarantees connectors the user did not pick for a message are never
    enumerated or spawned, avoiding errors from unwanted servers.
    """
    if not servers:
        return None
    try:
        fd, path = tempfile.mkstemp(prefix="coder-mcp-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": servers}, fh, ensure_ascii=False, indent=2)
        return path
    except OSError:
        return None


# Some stdio MCP servers (e.g. the Docker MCP Toolkit gateway) take several
# seconds to boot before they can answer the initialize handshake. pydantic-ai's
# default init_timeout is a tight 5s, which is too short for them — the client
# gives up with "Failed to initialize server session" although the server is
# fine. We load the config ourselves so we can pass a more generous timeout.
_MCP_INIT_TIMEOUT = 60.0  # seconds, for the connection + initialize handshake


def _load_mcp_toolsets(config_path: str) -> list[Any]:
    """Like ``pydantic_ai.mcp.load_mcp_toolsets`` but with a longer init timeout
    so slow-booting stdio servers actually connect.

    Accepts the same ``mcpServers`` JSON shape (``command``/``args``/``env``/
    ``cwd`` or ``url``/``headers``). Each server yields one prefixed toolset.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            config_data = json.load(fh)
    except (OSError, ValueError):
        return []

    servers = (config_data or {}).get("mcpServers")
    if not isinstance(servers, dict) or not servers:
        return []

    toolsets: list[Any] = []
    for name, server in servers.items():
        try:
            if "command" in server:
                transport = StdioTransport(
                    command=server["command"],
                    args=list(server.get("args") or []),
                    env=server.get("env"),
                    cwd=str(server["cwd"]) if server.get("cwd") else None,
                )
                toolset = MCPToolset(transport, id=name, init_timeout=_MCP_INIT_TIMEOUT)
            elif "url" in server:
                toolset = MCPToolset(
                    server["url"],
                    id=name,
                    headers=server.get("headers"),
                    init_timeout=_MCP_INIT_TIMEOUT,
                )
            else:
                continue
            toolsets.append(PrefixedToolset(toolset, name))
        except Exception as exc:  # noqa: BLE001
            print(f"[coder] mcp toolset '{name}' skipped: {exc}", flush=True)
    return toolsets


def _write_mcp_config(root: str, servers: dict) -> str | None:
    """Persist the app's MCP connectors to ``~/.coder/mcp.json`` (the Claude
    Code ``mcpServers`` JSON shape) and return its path.

    Merges ``servers`` (the UI's connector list) over any connectors the agent
    already added to the file via the ``create_mcp`` tool, so agent-created
    connectors survive subsequent runs.

    Returns ``None`` when there is nothing to load or the file can't be written.
    """
    if not servers:
        return None
    try:
        path = os.path.join(user_coder_dir(), "mcp.json")
        merged: dict = {}
        try:
            if os.path.isfile(path):
                with open(path, "r", encoding="utf-8") as fh:
                    parsed = json.load(fh)
                if isinstance(parsed, dict) and isinstance(parsed.get("mcpServers"), dict):
                    merged = parsed["mcpServers"]
        except (OSError, ValueError):
            merged = {}
        merged.update(servers or {})
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": merged}, fh, ensure_ascii=False, indent=2)
        return path
    except OSError:
        return None


def _load_attachments(root: str, rels: list[str]) -> list[str]:
    """Read attached files (absolute paths) into context blocks, sandboxed to root."""
    blocks: list[str] = []
    for raw in rels or []:
        rel = str(raw).strip()
        if not rel:
            continue
        try:
            target = resolve_safe(root, rel)
        except PathEscapeError:
            continue
        if not os.path.isfile(target) or not _is_text_path(target):
            continue
        try:
            content, truncated = _read_text(target)
        except OSError:
            continue
        if truncated:
            content += "\n... (file truncated)"
        display = os.path.relpath(target, resolve_safe(root, ""))
        blocks.append(f"===== ATTACHED FILE: {display} =====\n{content}")
    return blocks


_IMAGE_EXTS: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024


def _load_images(paths: list[str] | None) -> list[str]:
    """Read image files (absolute paths, not copied) into base64 data URIs."""
    uris: list[str] = []
    for raw in paths or []:
        p = str(raw).strip()
        if not p:
            continue
        ext = os.path.splitext(p)[1].lower()
        mime = _IMAGE_EXTS.get(ext)
        if not mime:
            continue
        try:
            with open(p, "rb") as fh:
                data = fh.read(_MAX_IMAGE_BYTES + 1)
        except OSError:
            continue
        if len(data) > _MAX_IMAGE_BYTES:
            continue
        uris.append(f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}")
    return uris


async def run_agent(
    provider: str,
    model_name: str,
    base_url: str,
    api_key: str,
    root: str,
    mode: str,
    prompt: str,
    history: list[dict],
    attachments: list[str] | None = None,
    images: list[str] | None = None,
    system_prompt: str = "",
    thinking_level: str = "",
    context_window: int = 0,
    env_var: str = "",
    mcp_servers: dict | None = None,
    skills_selected: list[str] | None = None,
) -> AsyncIterator[dict]:
    """Run the agent and yield SSE events (text deltas + tool activity)."""
    prompt = (prompt or "").strip()
    image_uris = _load_images(images)
    if not prompt and not image_uris:
        yield {"kind": "error", "content": "No prompt provided."}
        return

    model = build_model(provider, model_name, base_url, api_key, env_var)

    # Fall back to a conservative budget so tool outputs are always capped even
    # when the provider reports no context window.
    try:
        ctx = int(context_window or 0)
    except (TypeError, ValueError):
        ctx = 0
    if ctx <= 0:
        ctx = DEFAULT_CONTEXT_WINDOW

    queue: asyncio.Queue = asyncio.Queue()

    # Live per-request usage → the queue. `UsageCapability.after_model_request`
    # runs for every model request (each tool-loop step), forwarding that
    # request's provider-reported token usage so the UI context meter tracks the
    # REAL running count (no estimation) and so a near-overflow can be compacted
    # before it actually dies.
    early_usage_state = {"hit": False, "last": 0}
    _usage_cap = _UsageCapability(
        on_usage=lambda usage: (
            usage.update({"kind": "usage"}),
            queue.put_nowait(dict(usage)),
        )[1],
        context_limit=ctx,
        state=early_usage_state,
    )

    tools = make_tool_callbacks(
        root,
        lambda ev: queue.put_nowait(_tool_event(ev)),
        context_window=ctx,
    )
    # write_file, edit_file and run_terminal are reserved for codewriter mode.
    # Chat mode is read-only on PROJECT FILES but still gets create_skill and
    # create_mcp (adding skills / MCP connectors is allowed), plus web_search,
    # fetch_url and the read-only file tools.
    if mode != "codewriter":
        tools = {
            name: fn
            for name, fn in tools.items()
            if name not in ("write_file", "edit_file", "run_terminal")
        }
    registered = [Tool(fn, name=name) for name, fn in tools.items()]

    # MCP tool connectors: the UI's connector list is persisted to
    # ~/.coder/mcp.json and loaded into prefixed toolsets. Connection is
    # deferred, so a dead/broken server only surfaces if the model actually
    # calls one of its tools (that call fails gracefully), never at startup.
    # Only the servers the frontend sent for THIS turn are loaded — unselected
    # connectors (e.g. a docker MCP you aren't using right now) stay out.
    toolsets: list[Any] | None = None
    mcp_path = _write_mcp_config(root, mcp_servers or {})
    if mcp_path:
        try:
            # Build a run-scoped config with exactly the requested servers so
            # unselected connectors are never spawned or enumerated.
            filtered_path = _run_mcp_config(mcp_servers or {})
            if filtered_path:
                toolsets = _load_mcp_toolsets(filtered_path)
        except Exception as exc:  # noqa: BLE001
            print(f"[coder] mcp config ignored: {exc}", flush=True)
            toolsets = None

    workspace_note = (
        "\n\nYou are running in the user's desktop IDE. The current open WORKSPACE ROOT is:\n"
        f"{root}"
        "\nUse paths RELATIVE to this folder (e.g. 'src/main.py'), never absolute paths. "
        "When the user says 'list files', 'show the project', or just 'ls', call list_files with no path to list the workspace root rather than asking for a path. The file tools are sandboxed to this root; any path outside it will be rejected."
    )

    attached = _load_attachments(root, attachments)
    if attached:
        workspace_note += (
            "\n\nThe user attached files and their full contents appear at the START of the user's "
            "latest message (after the ==== ATTACHED FILE ==== markers). Read them — they are the "
            "primary focus of the request. If the user references one with an @mention, the @ is "
            "just a marker — use the plain relative path in any tool call."
        )

    system_final = (system_prompt or "").strip() or SYSTEM_PROMPTS.get(
        mode, SYSTEM_PROMPTS["chat"]
    ) + workspace_note

    # Persistent per-project instructions (AGENTS.md), if the project has one.
    # Always included in full (up to a cap) regardless of context budget —
    # see _load_project_memory for why this isn't subject to the scouting budget.
    try:
        project_memory = _load_project_memory(root)
    except Exception:  # noqa: BLE001
        project_memory = ""
    if project_memory:
        system_final += project_memory

    try:
        learned_memory = _load_learned_memory(root)
    except Exception:  # noqa: BLE001
        learned_memory = ""
    if learned_memory:
        system_final += learned_memory

    skills = _load_skills(root)
    if skills_selected is not None:
        wanted = {str(n).strip().lower() for n in skills_selected if str(n).strip()}
        skills = [s for s in skills if s["name"].strip().lower() in wanted]
    if skills:
        system_final += _skills_section(skills)

    agent = Agent(
        model,
        system_prompt=system_final,
        model_settings=_settings_for(mode, ctx, thinking_level, provider),
        tools=registered,
        toolsets=toolsets,
        capabilities=[_usage_cap],
    )

    user_content: list[Any] = []
    # Attach full file contents at the FRONT of the user turn so the model is
    # guaranteed to see them (weak models ignore long buried system prompts).
    if attached:
        user_content.append(
            "===== START OF ATTACHED FILES =====\n"
            + "\n\n".join(attached)
            + "\n===== END OF ATTACHED FILES =====\n"
        )

    # Auto-scout the workspace so the model always has project context even if
    # it never calls the file tools. Skipped when the user already attached most
    # of the project's entries, or when the request is clearly not about the
    # project (a general/external question like "is X.com free?", greetings, or
    # a web/MCP lookup) — no point scattering the listing into those turns. The
    # budget scales with the model's context window so small models (e.g. 8k)
    # get a tiny scouting budget that can't overflow the window.
    scout_budget = _AUTO_SCOUT_MAX_TOTAL
    if ctx > 0:
        scout_budget = max(0, min((ctx // 4) - 600, _AUTO_SCOUT_MAX_TOTAL * 6))
    try:
        scouted = _scout_workspace(root, max_total=scout_budget) if _needs_workspace(prompt) else ""
    except Exception:  # noqa: BLE001
        scouted = ""
    if attached and len(attached) >= 10:
        scouted = ""
    if scouted:
        user_content.append(scouted)

    # Keep the history small enough that the model's context window still has
    # room for the system prompt, scouting, tool-loop re-sends and the reply.
    # Without this, an 8k model overflows and gets truncated mid-task.
    history = _fit_history(history, _history_budget(ctx, system_final, scouted))
    history_messages = _to_model_messages(history)

    if prompt:
        user_content.append(prompt)
    user_content += [ImageUrl(url=uri) for uri in image_uris]

    # Retry loop: a transient failure (429 / 5xx / connection blip) on the
    # model call is retried with backoff, but ONLY while nothing has been
    # yielded to the client yet for this attempt — once any text or tool
    # activity has streamed out (which may mean a tool already ran, e.g. a
    # write), retrying from scratch could duplicate side effects, so at that
    # point a failure is surfaced as-is instead.
    attempt = 0
    auto_compacted = False
    scout_dropped = False
    while True:
        attempt += 1
        activity_happened = False
        # A mutating tool (write/edit/terminal) that already ran this attempt.
        # Once such a side effect lands, re-running the attempt from scratch
        # could duplicate it, so we refuse to auto-compact+retry AND refuse to
        # backoff-and-retry (mirroring the historical `activity_happened` guard).
        # Read-only tool calls / streamed text do NOT block auto-compact —
        # otherwise a model that lists/reads files and then overflows on the
        # very next model request would never auto-compact.
        mutating_ran = False
        # Fresh queue each attempt: `tools`' emit callback closes over the
        # `queue` name (late-bound), so reassigning it here is picked up by
        # tool calls in this attempt without rebuilding the tools/agent. This
        # also discards any stale sentinel left behind by a failed attempt.
        queue = asyncio.Queue()
        try:
            # run_stream_events runs the agent graph in a background task and
            # forwards every event (model text/thinking deltas AND tool
            # calls/results) over a live stream. Unlike `run_stream` — whose
            # `__aenter__` executes the ENTIRE graph (all tool calls) before
            # returning — this surfaces tool activity as it happens, so the
            # UI can render a tool card the moment the model invokes it.
            async with agent.run_stream_events(
                user_content,
                message_history=history_messages,
            ) as events:
                # Producer task: forwards the model's streaming text/thinking
                # deltas into the queue. Tool activity is pushed into the SAME
                # queue by the tool `emit` callback (see make_tool_callbacks).
                # The consumer loop below drains the queue independently of the
                # event stream, so tool events surface in the UI as soon as a
                # tool runs — even while the model is still generating.
                async def producer() -> None:
                    try:
                        async for event in events:
                            if isinstance(event, PartDeltaEvent):
                                delta = event.delta
                                if isinstance(delta, TextPartDelta):
                                    chunk = delta.content_delta
                                    if chunk:
                                        await queue.put(_event_delta(chunk))
                                elif isinstance(delta, ThinkingPartDelta):
                                    chunk = delta.content_delta
                                    if chunk:
                                        await queue.put(
                                            {"kind": "thinking", "content": chunk}
                                        )
                            elif isinstance(event, AgentRunResultEvent):
                                usage = _usage_event(event.result.usage)
                                if usage:
                                    await queue.put(usage)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001
                        # Re-raise into the consumer so the server can surface
                        # it as an SSE error instead of a silent cut.
                        await queue.put({"kind": "_raise", "error": exc})
                    finally:
                        await queue.put(None)

                producer_task = asyncio.create_task(producer())

                error: BaseException | None = None
                try:
                    while True:
                        item = await queue.get()
                        if item is None:
                            break
                        if item.get("kind") == "_raise":
                            error = item["error"]
                            break
                        # Track side-effecting tool calls so a later context
                        # overflow on a subsequent request doesn't trigger an
                        # unsafe full re-run that duplicates the write.
                        if item.get("kind") == "tool" and item.get("tool") in (
                            "write_file",
                            "edit_file",
                            "run_terminal",
                        ):
                            mutating_ran = True
                        activity_happened = True
                        yield item
                        # Pre-emptive auto-compact: if the provider just reported
                        # a request whose input already fills too much of the
                        # window, stop the loop here and re-send from compacted
                        # history BEFORE the next request dies with an overflow.
                        if (
                            early_usage_state["hit"]
                            and early_usage_state.get("last")
                            and item.get("kind") == "usage"
                        ):
                            tok = early_usage_state["last"]
                            raise _HighWatermark(tok, ctx)
                finally:
                    # Cancel the producer AND await it so its task (and the
                    # underlying model-event stream / pydantic-ai wrap_run task
                    # it iterates) fully unwinds. Without the await, the tasks
                    # are left pending on client disconnect (abort) and get
                    # garbage-collected, spamming "Task was destroyed but it is
                    # pending!".
                    producer_task.cancel()
                    try:
                        await producer_task
                    except (asyncio.CancelledError, Exception):
                        pass

                if error is not None:
                    raise error
            break  # success, exit the retry loop
        except Exception as exc:  # noqa: BLE001
            # Auto-compact: the request itself overflowed the model's context
            # window (not a transient blip). Shrink the body of the turn (history
            # first, then the auto-scout) and retry so the task can actually
            # finish. Only safe while no mutating tool has run (no side effects
            # to duplicate). Read-only tool calls / streamed text do NOT block
            # this — otherwise a model that lists/reads files and then overflows
            # on the very next request would never auto-compact.
            if (
                not mutating_ran
                and len(history) > 0
                and (_is_context_overflow(exc) or isinstance(exc, _HighWatermark))
                and (not auto_compacted or (scouted and not scout_dropped))
            ):
                auto_compacted = True
                # Report the real token count parsed from the overflow error so
                overflow_tokens = _overflow_tokens(exc) if _is_context_overflow(exc) else None
                if overflow_tokens:
                    yield {
                        "kind": "usage",
                        "input_tokens": overflow_tokens,
                        "output_tokens": 0,
                        "total_tokens": overflow_tokens,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                    }
                if isinstance(exc, _HighWatermark):
                    content = f"Context nearly full ({exc.tokens} of {exc.limit} tokens) — compacting earlier turns and continuing…"
                else:
                    content = "Context window was full — compacting earlier turns and continuing…"
                yield {"kind": "compact", "content": content}
                compacted = await _compact_history(model, history)
                # Compaction alone may not free enough room on a small window
                # (the retried request re-sends the whole turn). If there's no
                # history left to compress, drop the current turn's auto-scout
                # so the retry can actually fit.
                if compacted is None and scouted and not scout_dropped:
                    scout_dropped = True
                    user_content = [
                        c for c in user_content if not (isinstance(c, str) and c == scouted)
                    ]
                    yield {"kind": "retry", "attempt": attempt, "max_attempts": _RETRIES, "delay": 0, "reason": "overflowed — dropped auto-scout"}
                    continue
                if compacted is not None:
                    history = compacted
                    history_messages = _to_model_messages(history)
                    yield {"kind": "retry", "attempt": attempt, "max_attempts": _RETRIES, "delay": 0, "reason": "auto-compacted context"}
                    continue
            if activity_happened or attempt > _RETRIES or not _is_retryable(exc):
                raise
            delay = _RETRY_BASE_SECONDS * (2 ** (attempt - 1))
            yield {
                "kind": "retry",
                "attempt": attempt,
                "max_attempts": _RETRIES,
                "delay": delay,
                "reason": str(exc)[:200],
            }
            await asyncio.sleep(delay)
            continue
