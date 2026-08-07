# Codefa

> English description below — توضیحات فارسی در ادامه آمده است.

---

## What is Codefa? / کدفا چیست؟

**English —** Codefa is an **offline-first desktop coding assistant** built with
Electron. It gives you a full IDE-style workspace — a file explorer, a Monaco
editor and an AI chat panel — with an **AI agent (built on Pydantic AI) that
actually works inside your project**: it can open files, read them, search across
them and edit them *itself*, all confined to the folder you choose. You can talk
to it by typing *or* by voice (local whisper), and it streams its reasoning and
code changes in real time. It connects to your own models (OpenRouter, any
OpenAI-compatible API, or a local Ollama / llama.cpp / vLLM endpoint), so nothing
leaves your machine unless you want it to.

**فارسی —** کدفا یک **دستیار کدنویسی دسکتاپی با تمرکز بر آفلاین بودن** (با
Electron) است. تجربه‌ای شبیه به یک IDE کامل به شما می‌دهد: یک کاوشگر فایل، یک
ویرایشگر Monaco و یک پنل چت زیبا — و در آن یک **عامل‌هوش مصنوعی (مبتنی بر Pydantic AI)**
واقعاً داخل پروژهٔ شما کار می‌کند؛ یعنی می‌تواند فایل‌ها را باز کند، بخواند،
جستجو کند و حتی **خودش ویرایش‌شان کند** — آن هم فقط داخل همان پوشه‌ای که شما انتخاب
می‌کنید. می‌توانید با تایپ یا حتی با **صدا** (تبدیل گفتار به متنِ محلی) با آن گفتگو
کنید و جوابش را توکن‌به‌توکن و زنده دریافت کنید. به مدل‌های خودتان متصل می‌شود
(OpenRouter، هر API سازگار با OpenAI، یا یک آدرس محلی Ollama / llama.cpp / vLLM)؛
پس مگر شما بخواهید، چیزی از دستگاه شما خارج نمی‌شود.

---

## Feature overview — نمای کلی ویژگی‌ها

**English**

- 🔌 **Bring your own model** — OpenRouter, any OpenAI-compatible API, or a fully
  local endpoint; switch models from the UI.
- 🤖 **Real agent, not glorified autocomplete** — reads, searches, writes and
  edits your files inside a sandboxed project folder, including MCP connectors.
- 🎤 **Voice input** — hold a button, speak in Persian/English, get text (local whisper).
- 📊 **Live context meter** — see exactly how much of the model's context you've used.
- 🛟 **Never-stuck agent** — gracefully auto-compacts history on small context windows.
- 🖥️ **Full IDE UI** — file explorer, Monaco editor, markdown chat, dark/light theme.
- 🔒 **Safe by design** — every read/write/search confined to your chosen folder.
- 🔁 **Streaming + persistence** — token-by-token SSE, history kept in `~/.coder/`.

**فارسی**

- 🔌 **مدل‌تان را بیاورید** — OpenRouter، هر API سازگار با OpenAI یا یک آدرس محلی؛ تعویض فراهم‌کننده از خود رابط کاربری.
- 🤖 **یک عامل واقعی، نه تکمیل خودکار** — فایل‌ها را داخل پوشهٔ ایزوله می‌خواند، می‌نویسد، ویرایش می‌کند و MCP دارد.
- 🎤 **ورودی صوتی** — یک دکمه را نگه دارید، به فارسی یا انگلیسی صحبت کنید، متنش آماده می‌شود.
- 📊 **نوار بافت زنده** — ببینید دقیقاً چقدر از پنجرهٔ بافت مدل استفاده کرده‌اید.
- 🧊 **نابودشدنی نیست** — در بافت کم، به‌صورت هوشمند خودکار فشرده می‌شود تا نپرد.
- 🖥️ **رابط IDE کامل** — کاوشگر فایل، ویرایشگر، چت، تم تیره/روشن.
- 🔒 **امن از پایه** — هر خواندن/نوشتن/جستجو فقط داخل پوشهٔ انتخابی شما.
- 🔁 **استریم و ماندگاری** — خروجی توکن‌به‌توکن از طریق SSE؛ نگهداری در `~/.coder/`.

---

## English

### Features

- **Multi-provider LLM** — OpenRouter, any OpenAI-compatible API (llama.cpp / vLLM),
  and local Ollama — all driven through Pydantic AI.
- **Dynamic model switching** — models are fetched from the active provider and
  selectable directly from the UI settings.
- **Two agent modes** — `Chat` (conversational coding assistant) and
  `Code Writer` (autonomous code-writing agent). Toggle at the top of the chat
  panel or with `Cmd/Ctrl+M`.
- **Tool-based agent** — `read_file`, `write_file`, `list_files`,
  `search_in_files`, plus MCP connectors, all executed by the Pydantic AI sidecar
  and constrained to the project root.
- **Safe file access** — pick a project folder; every read/write/search is
  confined to it (path-traversal and symlink-escape guards in both Electron IPC
  and Python).
- **Voice input** — a push (mic) button records your voice and transcribes it with a
  fully local, offline `faster-whisper` model once installed; the text is then
  inserted into the composer. While recording, the mic icon animates into a
  live "wave" equalizer (Claude Code style).
- **Live context meter** — the context-usage bar updates in real time during
  long tool loops, using the provider's exact per-request token counts instead
  of an estimate.
- **Graceful small-context handling** — when the model's context window is small
  (e.g. an 8192-token local model) the agent pre-emptively compacts history at 80%
  of the window and auto-compacts on overflow, so the agent keeps working instead
  of crashing.
- **UI** — resizable file explorer (left), Monaco editor (center), streaming AI
  chat with markdown + syntax highlighting (right).
- **RTL / LTR** — chat messages use `direction: auto; unicode-bidi: plaintext` so
  Persian and English mix correctly; the whole README and UI support both.
- **Streaming** — token-by-token SSE streaming from the sidecar, no terminal output.
- **Persistence** — provider config and chat history stored in `~/.coder/`.
- **Bonus** — model caching, multiple chats, dark/light theme, keyboard shortcuts.

### Requirements

- Node.js >= 20 and npm
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Python >= 3.10 (managed by uv)

### Setup

```bash
npm install       # JS dependencies
npm run setup     # creates backend/.venv and installs pydantic-ai, fastapi, uvicorn
```

Voice input uses a fully local `faster-whisper` model (see `backend/whisper/`).
If it is missing, install it once:

```bash
npm run setup          # pulls faster-whisper into backend/.venv
# place / download the model into backend/whisper/ (config.json, model.bin, …)
```

### Development

```bash
npm run dev
```

Opens the Electron window with a hot-reloading renderer. The Python sidecar
(FastAPI + Pydantic AI) is auto-spawned on an ephemeral localhost port. When
launched from the packaged `.app`, Codefa also merges the GUI PATH with your login
shell path so tools such as `docker` (used by MCP stdio connectors) are found.

### Building / packaging

```bash
npm run build       # typecheck + build renderer, main and preload
npm run dist        # package for the current OS (dmg/zip on mac, NSIS exe on win, AppImage on linux)
npm run dist:mac    # only macOS
npm run dist:win    # only Windows
npm run dist:linux  # only Linux
```

Output lands in `release/`.

### Usage

1. Click **Open Folder** (or `Cmd/Ctrl+O`) and select your project root.
2. Open settings (`Cmd/Ctrl+,`). The default provider is **opencode**
   (`opencode/deepseek-v4-flash-free` via OpenRouter). You can switch to
   OpenRouter, a custom OpenAI-compatible API, or a local endpoint
   (Ollama / llama.cpp / vLLM), enter your API key / base URL, and pick a model.
3. Choose an agent mode: **Chat** or **Code Writer**.
4. Type a message and press `Cmd/Ctrl+Enter`. The agent streams its reply and
   uses sandboxed tools to inspect or modify files. Press the mic button to
   dictate instead of typing.

### Keyboard shortcuts

| Shortcut         | Action                                             |
| ---------------- | -------------------------------------------------- |
| `Cmd/Ctrl+Enter` | Send chat message                                  |
| `Cmd/Ctrl+M`     | Toggle agent mode (Chat / Code Writer)             |
| `Cmd/Ctrl+P`     | Quick-open / search overlay (⌘⇧F for content grep) |
| `Cmd/Ctrl+B`     | Toggle sidebar                                     |
| `Cmd/Ctrl+,`     | Open settings                                      |
| `Cmd/Ctrl+S`     | Save current file                                  |
| `Cmd/Ctrl+T`     | New chat                                           |

### Architecture

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
│ server.py     FastAPI /health /models    │
│               /chat/stream (SSE) /fs     │
│               /transcribe (Whisper)      │
│ providers.py  → pydantic-ai OpenAIModel  │
│ tools.py      sandboxed fs tools         │
│ agents.py     Chat / Code Writer agents  │
│               (live usage + compact)     │
└───────────────────────────────────────────┘
```

## Persian / فارسی

**کدفا** دستیار کدنویسی دسکتاپی مبتنی بر نسخهٔ تولیدی Electron همراه با پشتیبانی از
چند فراهم‌کننده (Provider) هوش مصنوعی و یک عامل Pydantic AI است که می‌تواند فایل‌ها
را داخل یک پوشهٔ پروژهٔ ایزوله (sandbox) بخواند، بنویسد و جستجو کند.

### امکانات

- **پشتیبانی چند فراهم‌کنندهٔ LLM** — OpenRouter، هر API سازگار با OpenAI
  (llama.cpp / vLLM) و Ollama محلی — همگی از طریق Pydantic AI.
- **تعویض پویای مدل** — مدل‌ها از فراهم‌کنندهٔ فعال دریافت و مستقیم از تنظیمات رابط کاربری انتخاب می‌شوند.
- **دو حالت عامل** — «چت» (دستیار گفتگویی کدنویسی) و «تولیدکنندهٔ کد/Code Writer»
  (عامل مستقل نوشتن کد). با دکمهٔ بالای پنل چت یا `Cmd/Ctrl+M` جابه‌جا شوید.
- **عامل مبتنی بر ابزار** — `read_file`، `write_file`، `list_files` و
  `search_in_files` به‌همراه اتصالات MCP، همگی توسط sidecar پایتونی اجرا و به پوشهٔ پروژه محدود می‌شوند.
- **دسترسی امن به فایل** — پوشهٔ پروژه را انتخاب کنید؛ هر خواندن/نوشتن/جستجو فقط
  داخل همان پوشه انجام می‌شود (حفاظت در برابر مسیرهای عبوری و symlink هم در IPC
  الکترون و هم در پایتون).
- **ورودی صوتی** — با دکمهٔ میکروفون صدای خود را ضبط کنید؛ با مدل **محلی و آفلاین**
  `faster-whisper` تبدیل به متن شده و در کادر متن گذاشته می‌شود. هنگام ضبط، دکمهٔ
  میکروفون به شکل اکولایزر موجدارِ زنده درمی‌آید (به سبک Claude Code).
- **نوار اندازهٔ بافت (Context Meter) زنده** — نوار استفاده از بافت هنگام حلقه‌های
  طولانی ابزار به‌صورت مستقیم و با تعداد توکن دقیق اعلام‌شدهٔ فراهم‌کننده به‌روزرسانی
  می‌شود، نه با برآورد.
- **مدیریت هوشمند بافت کم** — وقتی پنجرهٔ بافت مدل کوچک است (مثلاً مدل ۸۱۹۲ توکنی
  LM Studio)، عامل در ۸۰٪ ظرفیت به‌صورت پیش‌گیرانه بافت را فشرده می‌کند و در سرریز
  نیز خودکار فشرده‌سازی انجام می‌شود تا به‌جای خرابی، کار ادامه یابد.
- **رابط کاربری** — کاوشگر فایل قابل تغییر اندازه (چپ)، ویرایشگر Monaco (وسط) و
  چت هوش مصنوعیِ استریمی با markdown و هایلایت سینتکس (راست).
- **راست‌به‌چپ / چپ‌به‌راست** — پیام‌های چت از `direction: auto; unicode-bidi: plaintext`
  استفاده می‌کنند تا ترکیب فارسی و انگلیسی درست نمایش داده شود.
- **استریم** — خروجی رشته‌ای توکن‌به‌توکن از طریق SSE ساید‌کر‌، بدون خروجی ترمینال.
- **ماندگاری (Persistence)** — تنظیمات فراهم‌کننده و تاریخچهٔ گفتگو در `~/.coder/` ذخیره می‌شود.
- **مزیت‌های بیشتر** — حافظهٔ پنهان مدل، چند گفتگو، تم تیره/روشن و میانبرهای کلید.

### پیش‌نیازها

- Node.js >= 20 و npm
- [uv](https://docs.astral.sh/uv/) (مدیر بستهٔ پایتون)
- Python >= 3.10 (مدیریت با uv)

### نصب (Setup)

```bash
npm install       # وابستگی‌های جاوا اسکریپت
npm run setup     # ساخت backend/.venv و نصب pydantic-ai, fastapi, uvicorn
```

ورودی صوتی از مدل کاملاً محلیِ `faster-whisper` استفاده می‌کند (ببینید `backend/whisper/`).
اگر مدل از قبل موجود نیست، یک‌بار نصب کنید:

```bash
npm run setup          # نصب faster-whisper داخل backend/.venv
# فایل‌های مدل را در backend/whisper/ قرار/دانلود دهید (config.json, model.bin, …)
```

### توسعه

```bash
npm run dev
```

پنجرهٔ Electron با رابط داغ (hot-reload) باز می‌شود. sidecar پایتونی
(FastAPI + Pydantic AI) به‌صورت خودکار روی یک پورت محلی موقت اجرا می‌شود. در نسخهٔ
بسته‌بندی‌شده، PATH رابط گرافیکی با PATH شلِ ورود ترکیب می‌شود تا ابزارهایی مثل
`docker` (مورد استفادهٔ اتصالات MCP) پیدا شوند.

### ساخت / بسته‌بندی

```bash
npm run build       # typecheck + ساخت renderer، main و preload
npm run dist        # بسته بندی سیستم فعلی (dmg/zip در مک، NSIS در ویندوز، AppImage در لینوکس)
npm run dist:mac    # فقط macOS
npm run dist:win    # فقط ویندوز
npm run dist:linux  # فقط لینوکس
```

خروجی در `release/` قرار می‌گیرد.

### کاربرد

۱. روی **باز کردن پوشه** کلیک کنید (یا `Cmd/Ctrl+O`) و روت پروژه را انتخاب کنید.
۲. تنظیمات را باز کنید (`Cmd/Ctrl+,`). فراهم‌کنندهٔ پیش‌فرض **opencode**
   (`opencode/deepseek-v4-flash-free` ازطریق OpenRouter) است. می‌توانید به OpenRouter،
   یک API سازگار با OpenAI یا یک آدرس محلی (Ollama / llama.cpp / vLLM) بروید،
   کلید API / base URL را وارد کرده و مدل انتخاب کنید.
۳. حالت عامل را انتخاب کنید: **چت** یا **نویسندهٔ کد**.
۴. پیام بنویسید و `Cmd/Ctrl+Enter` را فشار دهید. عامل پاسخ را استریم می‌کند و برای
   بررسی یا ویرایش فایل‌ها از ابزارهای sandbox شده استفاده می‌کند. برای تایپ در، دکمهٔ
   میکروفون را فشار دهید.

### میان‌برهای تنها

| میان‌بر            | انجام                                  |
| ------------------ | -------------------------------------- |
| `Cmd/Ctrl+Enter` | ارسال پیام چت                                  |
| `Cmd/Ctrl+M`     | جابه‌جایی حالت عامل (چت / نویسندهٔ کد)        |
| `Cmd/Ctrl+P`     | جستجو/آور سریع (⌘⇧F برای گریپ محتوا) |
| `Cmd/Ctrl+B`     | نمایش/پنهان‌کردن نوار کناری                   |
| `Cmd/Ctrl+,`     | باز کردن تنظیمات                             |
| `Cmd/Ctrl+S`     | ذخیرهٔ فایل فعلی                               |
| `Cmd/Ctrl+T`     | گفتگوی جدید                                   |

### معماری

```
┌──────────────── الکترون ────────────────┐
│ main.ts        پنجره، اجرای sidecar، IPC فایل، │
│                پایداری‌سازی تنظیمات و گفتگو      │
│ preload.ts     contextBridge (محدودشده)      │
│ renderer       React + Monaco + چت (SSE)     │
└─────────┬──────────────────▲─────────────────┘
          │ spawn / stdio     │ HTTP + SSE (127.0.0.1)
┌─────────▼──────────────────┴─────────────────┐
│ ساید‌کار پایتون  (uv .venv)                       │
│ server.py    FastAPI /health /models          │
│              /chat/stream (SSE) /fs           │
│              /transcribe (Whisper)            │
│ providers.py → pydantic-ai OpenAIModel        │
│ tools.py     ابزارهای فایل sandboxچ          │
│ agents.py    عامل چت / عامل تولید کد          │
│              (استفادهٔ زنده + فشرده‌سازی)      │
└───────────────────────────────────────────────┘
```