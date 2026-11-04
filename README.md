# gemini-termium

> **Cross-Platform In-Terminal Google Gemini with Local Workspace Bridge**
> Powered by [Termium](https://github.com/codr1/termium) (Kitty Graphics, Sixel, ASCII/Half-block) on **macOS (Apple Silicon & Intel)** and **Linux**.

[English](README.md) | [日本語](README_ja.md)

---

## 💡 Overview

`gemini-termium` runs Google Gemini directly inside your terminal, bridging the web AI assistant with your local workspace:

- **Cross-Platform Rendering**: Runs seamlessly on **macOS** (Ghostty, iTerm2, WezTerm, Kitty) and **Linux** without requiring Wayland compositor privileges.
- **In-Process Unified Backend**: A single lightweight Node.js daemon manages the Chrome headless instance, local workspace Bridge, and Termium gRPC server (~80MB RAM).
- **Google Login Persistence**: Automatically inherits authentication from your system's Google Chrome or master profile across multiple project directories without repeated logins.
- **Autonomous Agent Mode (Human-in-the-Loop)**: Turn Gemini into an interactive coding assistant that can inspect workspace trees, read files, write code, and run tests under your explicit manual approval.
- **In-Page Slash Commands & Autocomplete**:
  - `/agent <prompt>`: Initiates an autonomous agent session with workspace file tree injection and tool execution tags.
  - `/run <cmd>`: Execute local terminal commands and inspect stdout in the on-screen console drawer.
  - `/status`, `/help`: Instant feedback and keyboard hints.
  - Interactive popup dropdown menu for slash command completion.
  - Action button injected directly onto response bash code blocks ("Run Locally").

---

## 🤖 Autonomous Agent Mode & TOS Compliance Policy

When using `/agent <task>`, `gemini-termium` injects a structured workspace file tree and system prompt instructing Gemini to operate as a local coding agent using bracketed tool tags:

- `[read]path/to/file[/read]`: Requests inspection of a local workspace file.
- `[write path="path/to/file"]content[/write]`: Proposes creating or modifying a workspace file.
- `[exec]command[/exec]`: Proposes running a local shell command (e.g., `npm test`, `git status`).

### Strictly Enforced Human-in-the-Loop Policy
To strictly comply with **Google's Terms of Service** and guarantee system security:
1. **No Unattended Execution**: The bridge will **never** automatically execute commands or apply file changes in the background without explicit human approval.
2. **Interactive Approval Card**: Whenever Gemini emits a tool call, a modal dialog appears in the terminal interface displaying the proposed action, target path, and command preview.
3. **Explicit Human Trigger**: The user must press `[y]` (Approve & Reply) or `[n]` (Reject). Only upon user approval will the command execute locally and the output be submitted back to Gemini.

---

## 🏗 Architecture

```mermaid
flowchart TD
    User["Terminal (Ghostty / WezTerm / iTerm2 / Kitty)"]
    Client["Termium Go Client (termium -s 127.0.0.1:50051)"]
    Backend["In-Process Node.js Backend\n- Termium gRPC Server (proto/bc.proto)\n- Local Workspace Bridge HTTP (/apply, /run, /actions/read)\n- CDP Auto Injector (__GTW_CDP_BRIDGE__)"]
    Chrome["Google Chrome (--headless=new)\n- Memory-optimized V8 flags\n- Isolated workspace user-data-dir (Cookie persistence)"]
    DOM["Gemini WebUI (gemini.google.com)\n- Human-in-the-Loop approval card\n- Slash command popup menu\n- Code block action buttons"]
    Workspace["Local Workspace ($PWD)"]

    User <-->|Kitty Graphics / Sixel / Half-block| Client
    Client <-->|gRPC (CaptureScreenshot / SendInput)| Backend
    Backend <-->|Puppeteer & CDP| Chrome
    Chrome <-->|DOM Manipulation| DOM
    Backend <-->|File I/O & Shell execution| Workspace
```

---

## 🚀 Quickstart

### Prerequisites
1. **Google Chrome** installed:
   - macOS: `/Applications/Google Chrome.app`
   - Linux: `/usr/bin/google-chrome` or `/usr/bin/chromium`
2. **Node.js** (>= 20)
3. A terminal with graphics support:
   - **Kitty Graphics**: [Ghostty](https://ghostty.org/), [Kitty](https://sw.kovidgoyal.net/kitty/), [WezTerm](https://wezfurlong.org/wezterm/) (recommended, true-color pixel rendering)
   - **Sixel Graphics**: [iTerm2](https://iterm2.com/), foot, xterm (VT340 mode)
   - **ASCII / Half-block fallback**: Works in any terminal (Alacritty, Apple Terminal)

### Installation

```bash
git clone https://github.com/your-username/gemini-termium.git
cd gemini-termium
npm install
npm run setup   # Automatically downloads matching Termium binary for macOS / Linux
```

### Usage

Run from any project directory:

```bash
cd /path/to/my-project
npx gemini-termium
```

#### One-Time Google Login
If you are not already logged into Google Chrome on your machine:

```bash
npx gemini-termium --login
```
A desktop window will open. Sign into your Google account once, then close the window. All workspaces will automatically stay signed in.

---

## ⚡ Slash Commands & Actions

| Command | Action |
| :--- | :--- |
| `/agent <task>` | Starts an autonomous coding session. Auto-scans workspace file tree and manages `[read]`, `[write]`, `[exec]` tool requests with Human-in-the-Loop approval. |
| `/run <cmd>` | Executes a shell command in your workspace directory and displays stdout in a slide-out drawer. |
| `/status` | Shows the current workspace path, connection status, and port info. |
| `/help` | Displays available slash commands and usage tips. |

---

## 🧪 Testing

```bash
npm test
```
Runs the full test suite including unit tests and end-to-end integration with headless Chrome and Termium gRPC.

---

## 📄 License
MIT
