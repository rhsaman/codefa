import { useEffect, useMemo, useRef, useState } from "react";
import { getActiveProvider, useStore, DEFAULT_MAX_HISTORY } from "../lib/store";
import { streamChat, fetchModels, transcribeAudio, respondPermission } from "../lib/api";
import { api, workspaceSkills, type WorkspaceSkill } from "../lib/fs";
import {
  contextPercent,
  estimateContextTokens,
  formatTokens,
} from "../lib/context";
import { supportsReasoning } from "../lib/thinking";
import { allModes, getMode } from "../lib/modes";
import type { AgentMode, ChatMessage, SidecarEvent, ToolActivity } from "../types";
import { ChatMessageView } from "./ChatMessage";
import { ModeSelect } from "./ModeSelect";

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "opencode",
  openrouter: "OpenRouter",
  custom: "Custom",
  ollama: "Ollama",
};

const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: "help", hint: "List all commands" },
  { name: "compact", hint: "Summarize & compact the chat context" },
  { name: "clear", hint: "Clear all messages in this chat" },
  { name: "new", hint: "Start a new chat" },
  { name: "undo", hint: "Undo the last user/assistant exchange" },
  { name: "redo", hint: "Redo the last undone exchange" },
  { name: "skill", hint: "Create a skill (describe what you want after the command)" },
  { name: "mcp", hint: "Create an MCP connector (describe what you want after the command)" },
];

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
]);

function relFromRoot(root: string, p: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root).split("/");
  const f = norm(p).split("/");
  let i = 0;
  while (i < r.length && i < f.length && r[i] === f[i]) i++;
  if (i < r.length) return null;
  const rel = f.slice(i).join("/");
  return rel || null;
}

const CHARS_PER_TOKEN = 4;

function sliceToBudget(
  history: Array<{ role: string; content: string }>,
  maxHistory: number,
  contextWindow?: number,
): Array<{ role: string; content: string }> {
  // Model-scale the history char budget so small-context models (8k) get a tiny
  // slice, mirroring the backend's own trimmer.
  const ctx = contextWindow && contextWindow > 0 ? contextWindow : 32000;
  const budget = Math.floor(ctx * 1.5); // chars (~37% of window at 4 chars/token); mirrors the backend's conservative history share
  const capped = history.slice(-maxHistory);
  const kept: typeof history = [];
  let acc = 0;
  for (const m of [...capped].reverse()) {
    if (kept.length > 0 && acc + m.content.length > budget) break;
    kept.push(m);
    acc += m.content.length;
  }
  return kept.reverse();
}

export function ChatPanel() {
  const chat = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId) ?? null,
  );
  const provider = useStore(
    (s) =>
      s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
      s.settings.providers[0],
  );
  const root = useStore((s) => s.root);
  const dir = useStore((s) => s.dir);
  const toggleDir = useStore((s) => s.toggleDir);
  const settings = useStore((s) => s.settings);
  const modes = useStore((s) => allModes(s.settings));
  const maxHistory = provider.maxHistory ?? DEFAULT_MAX_HISTORY;
  const nvimFile = useStore((s) => s.nvimFile);

  const wroot = chat?.root || root;
  const nvimRel = useMemo(() => {
    if (!nvimFile || !wroot) return null;
    return relFromRoot(wroot, nvimFile);
  }, [nvimFile, wroot]);
  // The label always shows when a Neovim file is detected; outside the workspace
  // we display the absolute path (it just can't be mentioned to the agent).
  const nvimLabel = nvimFile ? (nvimRel || nvimFile) : null;
  const systemPrompt = useStore((s) =>
    chat ? (s.settings.systemPrompts?.[chat.mode] ?? "") : "",
  );

  const [input, setInput] = useState(chat?.draft?.input ?? "");
  const [busy, setBusy] = useState(false);
  const [sidecarStatus, setSidecarStatus] = useState<"ok" | "fail">("ok");
  const [attachments, setAttachments] = useState<string[]>(
    chat?.draft?.attachments ?? [],
  );
  const [attLen, setAttLen] = useState(0);
  const [images, setImages] = useState<
    Array<{ path: string; name: string; dataUrl?: string }>
  >(chat?.draft?.images ?? []);
  const [cmdOpen, setCmdOpen] = useState<{ at: number } | null>(null);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [liveUsage, setLiveUsage] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const [skillChips, setSkillChips] = useState<
    Array<{ kind: "skill" | "mcp"; name: string; path?: string }>
  >(chat?.draft?.skillChips ?? []);
  const [wsSkills, setWsSkills] = useState<WorkspaceSkill[]>([]);
  const [permissionReq, setPermissionReq] = useState<{
    id: string;
    action: string;
    path?: string;
    reason?: string;
  } | null>(null);
  const mcpConnectors = useStore((s) => s.settings.mcpServers ?? {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastEventAt = useRef(0);
  /** Whether the open Neovim file is selected to be mentioned on the next send. */
  const [nvimMentioned, setNvimMentioned] = useState(false);
  /** Transient confirmation shown when the user switches the chat's mode. */
  const [modeNotice, setModeNotice] = useState<string | null>(null);

  // Switch the CURRENT chat's mode and confirm it visibly (so it's obvious the
  // change applies to this chat's next message, not a new chat).
  const changeMode = (mode: AgentMode) => {
    if (!chat) return;
    useStore.getState().setChatMode(chat.id, mode);
    const def = getMode(settings, mode);
    setModeNotice(`Mode changed to ${def.label} — your next message runs in this mode.`);
  };

  useEffect(() => {
    if (!modeNotice) return;
    const t = setTimeout(() => setModeNotice(null), 3500);
    return () => clearTimeout(t);
  }, [modeNotice]);

  useEffect(() => {
    window.coder
      .getSidecarUrl()
      .then((url) => setSidecarStatus(url ? "ok" : "fail"));
  }, []);

  // Track the file currently open in Neovim (fed by the main-process watcher,
  // which queries the nvim RPC socket). Only the path is stored here; the label
  // is shown automatically and the file is sent to the agent only when the user
  // explicitly clicks/selects it for that message.
  useEffect(() => {
    let cancelled = false;
    window.coder
      .getNvimFile()
      .then((abs) => {
        if (!cancelled) useStore.getState().setNvimFile(abs);
      })
      .catch(() => undefined);
    const unsub = window.coder.onNvimFile((f) => {
      if (!cancelled) useStore.getState().setNvimFile(f.abs);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Keep the pending composer state (input text + chips) scoped to THIS chat by
  // persisting it into the chat's draft whenever it changes. The ChatPanel is
  // keyed by activeChatId so switching chats remounts with that chat's own draft.
  useEffect(() => {
    if (!chat) return;
    useStore.getState().setChatDraft(chat.id, {
      input,
      attachments,
      images,
      skillChips,
    });
  }, [chat?.id, input, attachments, images, skillChips]);

  // Keep the model context window fresh from the provider's live /models list,
  // so the context meter reflects the model's real capacity (not a hardcoded
  // default). Refetch only when the provider's identity changes.
  useEffect(() => {
    let cancelled = false;
    if (!provider.kind) return;
    void fetchModels(provider)
      .then((res) => {
        if (!cancelled) useStore.getState().setProviderContextMap(provider.id, res.context);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, provider.kind, provider.baseUrl, provider.apiKey, provider.envVar]);

  useEffect(() => {
    if (!wroot || attachments.length === 0) {
      setAttLen(0);
      return;
    }
    let total = 0;
    attachments.forEach((a) => {
      void api
        .fsRead(wroot, a)
        .then((r) => {
          total += r.content.length;
          setAttLen(total);
        })
        .catch(() => undefined);
    });
  }, [wroot, attachments]);

  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
    setShowJump(!atBottom);
  };

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat?.messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    const onToggleMode = () => {
      if (chat) {
        const ids = allModes(useStore.getState().settings).map((m) => m.id);
        const idx = ids.indexOf(chat.mode);
        const next = ids[(idx + 1) % ids.length] ?? "ask";
        changeMode(next);
      }
    };
    const onAttachFile = (e: Event) => {
      const rel = (e as CustomEvent<{ rel: string }>).detail?.rel;
      if (!rel || !wroot) return;
      setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("coder:toggle-mode", onToggleMode);
    window.addEventListener("coder:attach-file", onAttachFile as EventListener);
    return () => {
      window.removeEventListener("coder:toggle-mode", onToggleMode);
      window.removeEventListener("coder:attach-file", onAttachFile as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, chat?.mode, wroot]);

  const filteredCmds = useMemo(() => {
    if (!cmdOpen) return [];
    const q = cmdQuery.toLowerCase();
    return COMMANDS.filter(
      (c) => c.name.includes(q) || c.hint.toLowerCase().includes(q),
    ).slice(0, 10);
  }, [cmdOpen, cmdQuery]);

const contextUsed = useMemo(() => {
  // Source of truth: the provider's OWN reported token usage from the last
  // completed assistant turn (the total the model's context limit check uses).
  // Matches opencode: tokenTotal = input + output + reasoning + cache. Falls
  // back to a char-based estimate only before the first reply lands (or when
  // the provider reports no usage).
  const msgs = chat?.messages ?? [];

  // During an in-flight turn the provider reports per-request usage via the
  // `usage` SSE event (forwarded from each tool-loop model request). That is the
  // REAL running token count — no estimation — so prefer it while streaming.
  // Once streaming ends the final message's persisted usage is the truth.
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant") {
    if (last.streaming && liveUsage !== null && liveUsage > 0) return liveUsage;
    if (!last.streaming && last.usage && last.usage.totalTokens > 0) {
      return last.usage.totalTokens;
    }
  }

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant" || !m.usage) continue;
    const total =
      m.usage.totalTokens > 0 ? m.usage.totalTokens : m.usage.inputTokens;
    if (total > 0) return total;
  }
  return estimateContextTokens(chat, systemPrompt, maxHistory);
}, [chat, systemPrompt, maxHistory, liveUsage]);

  const ctxWindow =
    (provider.contextMap?.[provider.model] &&
      provider.contextMap[provider.model] > 0 &&
      provider.contextMap[provider.model]) ||
    (provider.contextWindow && provider.contextWindow > 0
      ? provider.contextWindow
      : null);
  const ctxPct = contextPercent(contextUsed, ctxWindow);

  const send = async (
    text: string,
    atts: string[] = [],
    imgs: Array<{ path: string; name: string }> = [],
    allowCreate = false,
  ) => {
    const s = useStore.getState();
    const chat = s.chats.find((c) => c.id === s.activeChatId);
    if (!chat) return;
    const rootDir = chat.root || s.root;
    if (!rootDir) {
      const dir = await window.coder.selectFolder();
      if (!dir) return;
      s.setChatRoot(chat.id, dir);
    }
    const activeProvider = getActiveProvider();
    if (!activeProvider.model) {
      s.setSettingsOpen(true);
      return;
    }
    s.addRecentModel(activeProvider.model);

    // Selected skills / MCP connectors become an explicit instruction on this
    // turn (visible as chips in the composer, mirrored here for the model).
    const skillNotes: string[] = [];
    for (const chip of skillChips) {
      if (chip.kind === "skill") {
        skillNotes.push(
          `Read ${chip.path} and follow its instructions exactly.`,
        );
      } else {
        skillNotes.push(
          `Use the MCP tools from server "${chip.name}" where relevant.`,
        );
      }
    }
    const finalPrompt =
      skillNotes.length > 0
        ? `${text}\n\n=== USER-SELECTED SKILLS/TOOLS FOR THIS TURN ===\n${skillNotes.join(
            "\n",
          )}`
        : text;
    setSkillOpen(false);

    const userMsg = s.addMessage({
      role: "user",
      content: text,
      attachments: atts,
      images: imgs,
    });
    const assistantMsg = s.addMessage({
      role: "assistant",
      content: "",
      mode: chat.mode,
      toolActivity: [],
      streaming: true,
    });

    const allHistory = chat.messages
      .filter(
        (m) =>
          m.id !== userMsg.id &&
          (m.role === "user" || m.role === "assistant" || m.role === "system"),
      )
      .map((m) => ({ role: m.role, content: m.content }));
    const history = sliceToBudget(allHistory, maxHistory, ctxWindow ?? undefined);

    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setStalled(false);
    setLiveUsage(null);
    lastEventAt.current = Date.now();
    useStore.getState().setStreaming(true, false);

    // Watchdog: if the provider stalls (no SSE event at all), surface a hint so
    // the run doesn't silently hang at a "retrying" banner.
    const stallTimer = setInterval(() => {
      if (Date.now() - lastEventAt.current > 60_000) setStalled(true);
    }, 10_000);

    const handleEvent = (event: SidecarEvent) => {
      lastEventAt.current = Date.now();
      setStalled(false);
      const store = useStore.getState();
      const findMsg = () =>
        store.chats
          .find((c) => c.id === store.activeChatId)
          ?.messages.find((m) => m.id === assistantMsg.id);
      if (event.kind === "text") {
        useStore.getState().setStreaming(true, false);
        store.updateMessage(assistantMsg.id, {
          content:
            (findMsg()?.content ?? "") + (event.content ?? ""),
          retry: null,
        });
      } else if (event.kind === "thinking") {
        useStore.getState().setStreaming(true, true);
        store.updateMessage(assistantMsg.id, {
          thinking:
            (findMsg()?.thinking ?? "") + (event.content ?? ""),
          retry: null,
        });
      } else if (event.kind === "tool") {
        const act: ToolActivity = {
          tool: event.tool ?? "tool",
          args: event.args,
          status: "running",
          startedAt: Date.now(),
        };
        const current = findMsg()?.toolActivity ?? [];
        store.updateMessage(assistantMsg.id, {
          toolActivity: [...current, act],
          retry: null,
        });
      } else if (event.kind === "retry") {
        store.updateMessage(assistantMsg.id, {
          retry: {
            attempt: event.attempt ?? 1,
            maxAttempts: event.max_attempts ?? 3,
            delay: event.delay ?? 0,
            reason: event.reason ?? "",
          },
        });
      } else if (event.kind === "tool_result") {
        const current = findMsg()?.toolActivity ?? [];
        const now = Date.now();
        const next = current.map((a) => {
          if (a.tool === event.tool && a.status === "running") {
            return {
              ...a,
              status: "done" as const,
              summary: event.summary,
              elapsedMs: now - (a.startedAt ?? now),
            };
          }
          return a;
        });
        store.updateMessage(assistantMsg.id, { toolActivity: next });
      } else if (event.kind === "diff") {
        const current = findMsg()?.toolActivity ?? [];
        const next = current.map((a) => {
          if (a.tool === event.tool && a.status === "running") {
            return { ...a, diff: event.diff ?? "", summary: event.summary };
          }
          return a;
        });
        store.updateMessage(assistantMsg.id, { toolActivity: next });
      } else if (event.kind === "compact") {
        const base =
          store.chats
            .find((c) => c.id === store.activeChatId)
            ?.messages.find((m) => m.id === assistantMsg.id)?.content ?? "";
        store.updateMessage(assistantMsg.id, {
          content: base ? `${base}\n> *${event.content ?? ""}*` : `> *${event.content ?? ""}*\n`,
        });
      } else if (event.kind === "plan") {
        store.updateMessage(assistantMsg.id, {
          plan: event.items ?? [],
          retry: null,
        });
      } else if (event.kind === "permission") {
        setPermissionReq({
          id: event.id ?? "",
          action: event.action ?? "",
          path: event.path,
          reason: event.reason,
        });
      } else if (event.kind === "error") {
        store.updateMessage(assistantMsg.id, {
          content:
            (store.chats
              .find((c) => c.id === store.activeChatId)
              ?.messages.find((m) => m.id === assistantMsg.id)?.content ?? "") +
            `\n\n> **Error:** ${event.content}`,
          error: true,
        });
      } else if (event.kind === "usage") {
        const inputTokens = event.input_tokens ?? 0;
        const outputTokens = event.output_tokens ?? 0;
        setLiveUsage(event.total_tokens ?? inputTokens + outputTokens);
        store.updateMessage(assistantMsg.id, {
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: event.total_tokens ?? inputTokens + outputTokens,
            cacheReadTokens: event.cache_read_tokens,
            cacheWriteTokens: event.cache_write_tokens,
          },
        });
      }
    };

    try {
      await streamChat(
        {
          provider: activeProvider,
          root: rootDir,
          mode: chat.mode,
          prompt: finalPrompt,
          history,
          attachments: atts.map((a) => `${rootDir}/${a.replace(/^\/+/, "")}`),
          images: imgs.map((i) => i.path),
          systemPrompt: s.settings.systemPrompts?.[chat.mode] ?? "",
          thinkingLevel: supportsReasoning(activeProvider.model, activeProvider.kind)
            ? activeProvider.thinkingLevel ?? ""
            : "",
          mcpServers: (() => {
            const all = s.settings.mcpServers ?? {};
            const picked = skillChips.filter((c) => c.kind === "mcp").map((c) => c.name);
            const sel: Record<string, typeof all[string]> = {};
            for (const n of picked) if (all[n]) sel[n] = all[n];
            return sel;
          })(),
          skills: skillChips.filter((c) => c.kind === "skill").map((c) => c.name),
          allowCreate,
          cap: getMode(s.settings, chat.mode).capabilities,
          allowOutside: s.outsideAllowed,
          nvimFile: nvimMentioned ? nvimRel || undefined : undefined,
          signal: abort.signal,
        },
        handleEvent,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        handleEvent({ kind: "error", content: (err as Error).message });
      }
    } finally {
      clearInterval(stallTimer);
      setStalled(false);
      setBusy(false);
      abortRef.current = null;
      setNvimMentioned(false);
      useStore.getState().setStreaming(false, false);
      useStore.getState().updateMessage(assistantMsg.id, { streaming: false });
    }
  };

  const compactContext = async () => {
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === s.activeChatId);
    if (!ch) return;
    const msgs = ch.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    if (msgs.length === 0) return;
    const transcript = msgs
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(-120000);
    const rootDir = ch.root || s.root;
    setBusy(true);
    const prompt =
      "Summarize the following conversation into concise notes for continued work. " +
      "Keep key decisions, files touched, and open questions. Answer in the language of the conversation, " +
      "under 150 words, no preamble.\n\n" +
      transcript;
    let summary = "";
    try {
      await streamChat(
        {
          provider: getActiveProvider(),
          root: rootDir,
          mode: ch.mode,
          prompt,
          history: [],
          systemPrompt: s.settings.systemPrompts?.[ch.mode] ?? "",
          cap: getMode(s.settings, ch.mode).capabilities,
          mcpServers: s.settings.mcpServers ?? {},
        },
        (ev) => {
          if (ev.kind === "text") summary += ev.content ?? "";
          else if (ev.kind === "error")
            summary = summary || `(compact failed: ${ev.content})`;
        },
      );
    } catch (err) {
      summary = `(compact failed: ${(err as Error).message})`;
    } finally {
      setBusy(false);
    }
    s.compactChat(
      ch.id,
      `[Compacted conversation]\n${summary.trim() || "(empty summary)"}`,
    );
  };

  const handleCommand = async (v: string) => {
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === s.activeChatId);
    const word = v.split(/\s+/)[0].toLowerCase();
    switch (word) {
      case "/compact":
        await compactContext();
        break;
      case "/clear":
        if (ch) s.clearChat(ch.id);
        break;
      case "/new":
        s.newChat(ch?.mode);
        break;
      case "/undo":
        if (ch && s.undoMessage()) {
          s.addMessage({ role: "assistant", content: "↩ Undone." });
        } else {
          s.addMessage({ role: "assistant", content: "Nothing to undo." });
        }
        break;
      case "/redo":
        if (ch && s.redoMessage()) {
          s.addMessage({ role: "assistant", content: "↪ Redone." });
        } else {
          s.addMessage({ role: "assistant", content: "Nothing to redo." });
        }
        break;
      case "/help":
        s.addMessage({
          role: "assistant",
          content:
            "**Commands**\n\n" +
            COMMANDS.map((c) => `- \`/${c.name}\` — ${c.hint}`).join("\n"),
        });
        break;
      case "/skill":
      case "/mcp": {
        const target = word === "/skill" ? "skill" : "MCP connector";
        const rest = v.slice(word.length).trim();
        if (!rest) {
          s.addMessage({
            role: "assistant",
            content:
              word === "/skill"
                ? `Usage: \`/skill <description>\` — describe the skill you want after the command, e.g. \`/skill summarize a project's git log into release notes\`.`
                : `Usage: \`/mcp <description>\` — describe the tool/connector you want after the command, e.g. \`/mcp a way to search YouTube\`.`,
          });
          return;
        }
        s.addMessage({
          role: "user",
          content: v,
        });
        void send(
          target === "skill"
            ? `Create a new skill from this description: "${rest}". Use the create_skill tool to set it up with a good its name/slug and the instructions. Ask me only for anything essential that is genuinely missing; otherwise just create it. Do not modify files outside creating this skill.`
            : `Create a new MCP connector from this description: "${rest}". Use the create_mcp tool to add it, choosing a good name and command/URL/config that fits the description. Ask me only for anything essential that is genuinely missing; otherwise just create it. Do not modify files for this.`,
          [],
          [],
          true,
        );
        break;
      }
      default:
        s.addMessage({
          role: "assistant",
          content: `Unknown command \`${word}\`. Type \`/help\` to see available commands.`,
        });
    }
  };

  const retryMessage = (id: string) => {
    if (busy) return;
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === s.activeChatId);
    if (!ch) return;
    const msg = ch.messages.find((m) => m.id === id);
    if (!msg || msg.role !== "user" || !msg.content.trim()) return;
    if (!s.truncateTo(id)) return;
    const text = msg.content;
    void send(text, msg.attachments ?? [], msg.images ?? []);
  };

  const submit = () => {
    if (busy) return;
    const v = input.trim();
    if (!v && images.length === 0) return;
    if (v.startsWith("/")) {
      setInput("");
      setCmdOpen(null);
      void handleCommand(v);
      return;
    }
    setInput("");
    setCmdOpen(null);
    const atts = attachments;
    const imgs = images;
    setImages([]);
    void send(v, atts, imgs);
  };

  const addImage = (p: string, name: string) => {
    setImages((imgs) =>
      imgs.some((i) => i.path === p) ? imgs : [...imgs, { path: p, name }],
    );
    void api
      .readImage(p)
      .then((dataUrl) => {
        if (dataUrl)
          setImages((imgs) =>
            imgs.map((i) => (i.path === p ? { ...i, dataUrl } : i)),
          );
      })
      .catch(() => undefined);
  };

  const addDroppedFile = (p: string, name: string) => {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTS.has(ext)) {
      addImage(p, name);
      return;
    }
    if (!wroot) return;
    const rel = relFromRoot(wroot, p);
    if (!rel) return;
    setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types?.includes("Files")) setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    for (const f of dropped) {
      const p =
        window.coder.getPathForFile(f) || (f as File & { path?: string }).path;
      if (p) addDroppedFile(p, f.name);
    }
  };

  const addShot = (shot: { path: string; dataUrl: string }) => {
    setImages((imgs) =>
      imgs.some((i) => i.path === shot.path)
        ? imgs
        : [
          ...imgs,
          { path: shot.path, name: "screenshot.png", dataUrl: shot.dataUrl },
        ],
    );
  };

  const captureRegion = async () => {
    const shot = await api.captureRegion().catch(() => null);
    if (shot) addShot(shot);
  };

  const attachFile = async () => {
    const path = await api.selectFile();
    if (!path) return;
    const name = path.split(/[\\/]/).pop() || path;
    setImages((imgs) =>
      imgs.some((i) => i.path === path) ? imgs : [...imgs, { path, name }],
    );
    const dataUrl = await api.readImage(path).catch(() => null);
    if (dataUrl) {
      setImages((imgs) =>
        imgs.map((i) => (i.path === path ? { ...i, dataUrl } : i)),
      );
    }
  };

  const removeImage = (path: string) => {
    setImages((imgs) => imgs.filter((i) => i.path !== path));
  };

  const startRecording = async () => {
    if (recording || transcribing || busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer a format the sidecar's `av` can decode; fall back to whatever the
      // browser supports (Whisper handles webm/ogg/opus/wav via decode_audio).
      const mime =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : MediaRecorder.isTypeSupported("audio/wav")
              ? "audio/wav"
              : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) mediaChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = mediaChunksRef.current[0]?.type ?? mime;
        const blob = new Blob(mediaChunksRef.current, { type });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob, setTranscribing);
          if (text) {
            setInput((prev) => (prev ? prev.trimEnd() + " " + text : text));
            textareaRef.current?.focus();
          }
        } catch (err) {
          window.alert(
            `Voice transcription failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      window.alert(
        `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const stopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
      mediaRecorderRef.current = null;
    }
  };

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  const startCmd = (at?: number) => {
    const el = textareaRef.current;
    if (!el || busy) return;
    const pos = at ?? el.selectionStart;
    const prevChar = pos > 0 ? input[pos - 1] : "";
    if (prevChar && !/\s/.test(prevChar)) return;
    setCmdOpen({ at: pos });
    setCmdQuery("");
    setCmdIndex(0);
  };

  const acceptCmd = (name: string) => {
    if (!cmdOpen) return;
    const before = input.slice(0, cmdOpen.at);
    const after = input.slice(cmdOpen.at + 1 + cmdQuery.length);
    const next = `${before}/${name} ${after}`;
    setInput(next);
    setCmdOpen(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const pos = before.length + name.length + 2;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const removeAttachment = (rel: string) => {
    setAttachments((a) => a.filter((x) => x !== rel));
  };

  const openSkillPicker = async () => {
    setSkillOpen((o) => !o);
    if (wroot) {
      const sk = await workspaceSkills(wroot).catch(() => []);
      setWsSkills(sk);
    }
  };

  const toggleSkillChip = (item: { kind: "skill" | "mcp"; name: string; path?: string }) => {
    setSkillChips((chips) => {
      const exists = chips.some((c) => c.kind === item.kind && c.name === item.name);
      return exists
        ? chips.filter((c) => !(c.kind === item.kind && c.name === item.name))
        : [...chips, item];
    });
    setSkillOpen(false);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const prev = input;
    setInput(v);

    // Trigger popups from the inserted character (works on any keyboard layout
    // / IME, unlike e.key which can differ on Persian etc.).
    if (v.length === prev.length + 1) {
      const ch = v[v.length - 1];
      if (ch === "/" && !cmdOpen) startCmd(v.length - 1);
    }

    if (cmdOpen) {
      if (v[cmdOpen.at] !== "/") {
        setCmdOpen(null);
      } else {
        const after = v.slice(cmdOpen.at + 1);
        if (after.search(/\s/) !== -1) {
          setCmdOpen(null);
        } else {
          setCmdQuery(after);
          setCmdIndex(0);
        }
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmdOpen && filteredCmds.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdIndex((i) => (i - 1 + filteredCmds.length) % filteredCmds.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCmd(filteredCmds[cmdIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdOpen(null);
        return;
      }
    }
    if (cmdOpen && e.key === "Escape") {
      e.preventDefault();
      setCmdOpen(null);
      return;
    }
    if (skillOpen && e.key === "Escape") {
      e.preventDefault();
      setSkillOpen(false);
      return;
    }

    if (e.key === "/" && !cmdOpen && !(e.metaKey || e.ctrlKey)) {
      startCmd();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const stop = () => abortRef.current?.abort();

  if (!chat) {
    return (
      <div className="chat-panel">
        <div
          className="empty-state"
          style={{ display: "flex", height: "100%", alignItems: "center" }}
        >
          <div>
            <h2>No chat selected</h2>
            <button
              className="btn"
              onClick={() => useStore.getState().newChat()}
            >
              New chat
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-toolbar">
        <button
          className="dir-toggle"
          onClick={toggleDir}
          title={
            dir === "rtl"
              ? "Right-to-left (فارسی) — click for LTR"
              : "Left-to-right — click for RTL"
          }
        >
          {dir === "rtl" ? "RTL" : "LTR"}
        </button>
        <span className="badge" title="Active model">
          <span className="badge-provider">
            {provider.name || PROVIDER_LABELS[provider.kind] || provider.id}
          </span>
          {provider.model || "no model"}
        </span>
        <span
          className={`badge context-meter${ctxPct !== null && ctxPct >= 70 ? " warn" : ""}`}
          title={
            ctxWindow != null
              ? `Context used: provider-reported input tokens from the last turn (of the model's ${formatTokens(ctxWindow)} window)`
              : "Context used: provider-reported input tokens from the last turn"
          }
          dir="ltr"
        >
          {formatTokens(contextUsed)}
          {ctxPct !== null ? ` (${ctxPct}%)` : ""}
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <ModeSelect
            modes={modes}
            value={chat.mode}
            onChange={changeMode}
          />
          <span
            className={`status-dot ${sidecarStatus}`}
            title={
              sidecarStatus === "ok"
                ? "Agent ready"
                : "Agent not ready (npm run setup)"
            }
          />
          <button
            className="btn secondary"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => useStore.getState().newChat(chat.mode)}
          >
            + New chat
          </button>
        </span>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
        <div className="chat-messages" data-dir={dir}>
          {chat.messages.length === 0 && (
            <div className="empty-state">
              <h2>{getMode(settings, chat.mode).label} mode</h2>
              <p>{getMode(settings, chat.mode).description}</p>
            </div>
          )}
          {chat.messages.map((m: ChatMessage) => (
            <ChatMessageView key={m.id} message={m} onRetry={retryMessage} />
          ))}
        </div>
        {showJump && (
          <button
            className="scroll-jump"
            title="Scroll to bottom"
            onClick={() => {
              stickToBottom.current = true;
              setShowJump(false);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>

      <div
        className={`composer${dragOver ? " dragover" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="composer-inner">
          {dragOver && (
            <div className="drop-overlay">Drop files or images to attach</div>
          )}
          {modeNotice && (
            <div className="mode-notice" dir="ltr">{modeNotice}</div>
          )}
          <div className="composer-input-wrap">
            {cmdOpen && (
              <div className="mention-popup" dir="ltr">
                {filteredCmds.length === 0 && (
                  <div className="mention-empty">No matching commands</div>
                )}
                {filteredCmds.map((c, i) => (
                  <div
                    key={c.name}
                    className={`mention-item ${i === cmdIndex ? "active" : ""}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptCmd(c.name);
                    }}
                  >
                    <span className="mention-icon">/</span>
                    <span className="mention-rel">/{c.name}</span>
                    <span className="mention-hint">{c.hint}</span>
                  </div>
                ))}
              </div>
            )}
            {skillOpen && (
              <div className="mention-popup" dir="ltr">
                <div className="mention-group">Skills</div>
                {wsSkills.length === 0 && (
                  <div className="mention-empty">
                    No skills in this workspace — add them in Settings → Skills
                  </div>
                )}
                {wsSkills.map((s) => {
                  const active = skillChips.some(
                    (c) => c.kind === "skill" && c.name === s.name,
                  );
                  return (
                    <div
                      key={s.path}
                      className={`mention-item ${active ? "active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        toggleSkillChip({
                          kind: "skill",
                          name: s.name,
                          path: s.path,
                        });
                      }}
                    >
                      <span className="mention-icon">✦</span>
                      <span className="mention-rel">{s.name}</span>
                      <span className="mention-hint">
                        {s.description || s.path}
                      </span>
                    </div>
                  );
                })}
                <div className="mention-group">MCP tools</div>
                {Object.keys(mcpConnectors).length === 0 && (
                  <div className="mention-empty">
                    No MCP connectors — add them in Settings → MCP
                  </div>
                )}
                {Object.entries(mcpConnectors).map(([name]) => {
                  const active = skillChips.some(
                    (c) => c.kind === "mcp" && c.name === name,
                  );
                  return (
                    <div
                      key={name}
                      className={`mention-item ${active ? "active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        toggleSkillChip({ kind: "mcp", name });
                      }}
                    >
                      <span className="mention-icon">🔌</span>
                      <span className="mention-rel">{name}</span>
                      <span className="mention-hint">MCP server</span>
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="composer-input"
              rows={1}
              dir="ltr"
              style={{ direction: "ltr", textAlign: "left" }}
              placeholder={
                wroot
                  ? "Ask the agent…  (⌘P file · ⚡ skill · / command)"
                  : "Open a project folder first (⌘O)…"
              }
              value={input}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
            />
          </div>

          {nvimLabel && (
            <button
              type="button"
              className={`nvim-label${nvimMentioned ? " selected" : ""}`}
              dir="ltr"
              title={
                nvimMentioned
                  ? "Will be mentioned in your next message — click to deselect"
                  : `Open in Neovim: ${nvimFile} — click to mention in your next message`
              }
              onClick={() => setNvimMentioned((m) => !m)}
            >
              <span className="nvim-glyph">nvim</span>
              <span className="nvim-file">{nvimLabel}</span>
              <span className="nvim-check">{nvimMentioned ? "✓" : "+"}</span>
            </button>
          )}

          {(attachments.length > 0 || images.length > 0 || skillChips.length > 0) && (
            <div className="attachment-chips" dir="ltr">
              {skillChips.map((c) => (
                <span
                  className="attachment-chip skill-chip"
                  key={`${c.kind}-${c.name}`}
                >
                  {c.kind === "skill" ? "✦" : "🔌"} {c.name}
                  <button
                    className="chip-x"
                    onClick={() => toggleSkillChip(c)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {attachments.map((a) => (
                <span className="attachment-chip" key={a}>
                  {a}
                  <button
                    className="chip-x"
                    onClick={() => removeAttachment(a)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {images.map((img) => (
                <span className="attachment-chip image-chip" key={img.path}>
                  {img.dataUrl ? (
                    <img className="chip-thumb" src={img.dataUrl} alt="" />
                  ) : (
                    <span className="chip-thumb placeholder" />
                  )}
                  <span className="chip-name">{img.name}</span>
                  <button
                    className="chip-x"
                    onClick={() => removeImage(img.path)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="composer-row">
            <span className="composer-left">
              <ModeSelect
                modes={modes}
                value={chat.mode}
                iconOnly
                onChange={changeMode}
              />
            </span>
            <span className="composer-hint">
              {busy && (
                <span className={`composer-working${stalled ? " warn" : ""}`}>
                  {stalled
                    ? "Still waiting for the provider… (Stop to cancel)"
                    : "Agent is working…"}
                </span>
              )}
            </span>
            <div className="composer-actions">
              <button
                className={`icon-btn attach-btn mic-btn ${recording ? "recording" : ""} ${transcribing ? "transcribing" : ""}`}
                onClick={toggleRecording}
                disabled={busy}
                title={
                  transcribing
                    ? "Transcribing voice…"
                    : recording
                      ? "Stop recording"
                      : "Record voice input"
                }
              >
                {recording ? (
                  <span className="wave animate" aria-hidden="true">
                    <span className="wave-bar" />
                    <span className="wave-bar" />
                    <span className="wave-bar" />
                    <span className="wave-bar" />
                  </span>
                ) : transcribing ? (
                  <span className="wave transcribing" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 9l0 6" />
                      <path d="M12 7l0 10" />
                      <path d="M16 9l0 6" />
                    </svg>
                  </span>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                )}
              </button>
              <button
                className="icon-btn attach-btn"
                onClick={captureRegion}
                disabled={busy}
                title="Capture a region of the screen"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
              <button
                className="icon-btn attach-btn"
                onClick={attachFile}
                disabled={busy}
                title="Attach an image or file"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <button
                className={`icon-btn attach-btn${skillChips.length > 0 ? " has-chips" : ""}`}
                onClick={() => void openSkillPicker()}
                disabled={busy}
                title="Add skills / MCP tools to this message"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </button>
              {busy ? (
                <button
                  className="icon-btn stop-btn"
                  onClick={stop}
                  title="Stop"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className="icon-btn send-btn"
                  disabled={!input.trim() && images.length === 0}
                  onClick={submit}
                  title="Send"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {permissionReq && (
        <div className="perm-overlay">
          <div className="perm-dialog">
            <div className="perm-dialog-title">Outside workspace access</div>
            <div className="perm-dialog-action">
              {permissionReq.action}
              {permissionReq.path ? (
                <code className="perm-dialog-path">{permissionReq.path}</code>
              ) : null}
            </div>
            {permissionReq.reason ? (
              <div className="perm-dialog-reason">{permissionReq.reason}</div>
            ) : null}
            <div className="perm-dialog-note">
              This lets the agent work outside your current workspace.
            </div>
            <div className="perm-dialog-buttons">
              <button
                type="button"
                className="btn perm-deny"
                onClick={() => {
                  void respondPermission(permissionReq.id, false);
                  setPermissionReq(null);
                }}
              >
                Deny
              </button>
              <button
                type="button"
                className="btn perm-allow"
                onClick={() => {
                  void respondPermission(permissionReq.id, true);
                  setPermissionReq(null);
                }}
              >
                Allow once
              </button>
              <button
                type="button"
                className="btn perm-allow-always"
                onClick={() => {
                  void respondPermission(permissionReq.id, true);
                  useStore.getState().setOutsideAllowed(true);
                  setPermissionReq(null);
                }}
              >
                Always allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
