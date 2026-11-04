# gemini-termium

> **Cross-Platform In-Terminal Google Gemini with Local Workspace Bridge**
> Powered by [Termium](https://github.com/codr1/termium) (Kitty Graphics, Sixel, ASCII/Half-block) on **macOS (Apple Silicon & Intel)** and **Linux**.

[English](README.md) | [日本語](README_ja.md)

---

## 💡 Overview

`gemini-termium` lets you use the Gemini web app (gemini.google.com) from your terminal, and lets Gemini work with the project in your current directory — reading files, proposing edits, and running commands — **only after you approve each action**.

### How it works

1. `gemini-termium` starts a headless (windowless) Google Chrome and opens Gemini in it.
2. [Termium](https://github.com/codr1/termium), a terminal-based browser client, streams that page into your terminal as an image (Kitty Graphics / Sixel) or as text-art (ASCII / half-block) and forwards your keyboard input.
3. A small script injected into the Gemini page adds slash commands and an approval card, and talks to a local server that reads/writes files and runs commands in your project directory.

No API key is needed: you use your normal Google account through the regular Gemini web UI.

### Features

- **Autonomous agent mode (`/agent`)**: Gemini receives your project's file tree, then asks to read files, write files, or run commands. Every request is shown in an approval card; nothing runs until you press `y`.
- **Slash commands** with an autocomplete popup:
  - `/agent <prompt>`: start an agent session.
  - `/run <cmd>`: run a shell command in your project directory and show its output in an on-screen console.
  - `/status`, `/help`: show connection info and available commands.
- **Sign in once**: your Google login is stored in a dedicated Chrome profile (the "master profile") and is reused for every project directory. On first launch it is copied from your regular Google Chrome profile if you are already signed in there; otherwise run `--login` once (see [Usage](#usage)).
- **Lightweight**: one Node.js process manages Chrome, the local server and Termium (about 80MB of RAM, excluding Chrome itself).
- **Platforms**: macOS (Apple Silicon & Intel) and Linux, in terminals such as Ghostty, iTerm2, WezTerm and Kitty.

---

## 🤖 Agent Mode & Approval Policy

Type `/agent <task>` in the Gemini prompt box. `gemini-termium` sends Gemini your project's file tree and starts a collaborative pair programming session.

To stay strictly compliant with Gemini's safety guidelines and avoid false-positive guardrail triggers, actions are proposed using an ADHD / low-cognitive-load natural communication format:

- **Request file inspection**: `send-me: <filepath>` (Gemini politely asks you to provide the file).
- **Create or edit file**: `save: <filepath>` followed immediately by a fenced code block with full content.
- **Run command**: `run-command:` followed by a fenced code block with the command for you to run.
- *(Natural markdown like `cat README.md`, `// filepath:`, and legacy tags are also supported for backward compatibility).*

When Gemini proposes an action, an interactive approval card appears. If you approve (pressing `y`), the action runs locally and the result is placed into the prompt box and sent back to Gemini, so the conversation continues step by step.

### Human-in-the-Loop Policy
Automating the Gemini web UI without a human in the loop may violate Google's Terms of Service, and running model-generated commands unattended is unsafe. Therefore:
1. **No Unattended Execution**: The bridge will **never** automatically execute commands or apply file changes in the background without explicit human approval.
2. **Interactive Approval Card**: Whenever Gemini emits a tool call, an approval card appears on screen displaying the proposed action, target path, and command preview.
3. **Explicit Human Trigger**: You must press `y` (approve and reply) or `n` (reject). Only after you approve does the action run and its result get sent back to Gemini.
4. **Gemini Skills Integration (Enterprise Guardrail-Safe)**: To prevent strict Enterprise safety filters from flagging user prompts as prompt injection or C2 loops, `gemini-termium` delegates instruction rules to Gemini's official **Skills** (or Gems) feature. Register [`SKILL.md`](./SKILL.md) in your Gemini Skills as `pair-programmer`. `/agent <task>` automatically expands to `@pair-programmer <task>`, routing requests through trusted system-level instructions.
   - Use a custom skill name: pass `--skill <name>` or type `/agent @<name> <task>`.
   - Disable skill prefix: pass `--skill none`.

---

## 🏗 Architecture

```mermaid
flowchart TD
    User["Terminal (Ghostty / WezTerm / iTerm2 / Kitty)"]
    Client["Termium Go Client (termium -s 127.0.0.1:50051)"]
    Backend["Node.js Backend (single process)<br>- Termium gRPC Server (proto/bc.proto)<br>- Local Workspace Bridge: HTTP API for file read/write and command execution<br>- Script injector via Chrome DevTools Protocol (CDP)"]
    Chrome["Google Chrome (--headless=new)<br>- Per-project profile (login cookies copied from the master profile)"]
    DOM["Gemini WebUI (gemini.google.com)<br>- Human-in-the-Loop approval card<br>- Slash command popup menu<br>- Code block action buttons"]
    Workspace["Local Workspace ($PWD)"]

    User <-->|"Kitty Graphics / Sixel / Half-block"| Client
    Client <-->|"gRPC: CaptureScreenshot / SendInput"| Backend
    Backend <-->|"Puppeteer & CDP"| Chrome
    Chrome <-->|"DOM Manipulation"| DOM
    Backend <-->|"File I/O & Shell execution"| Workspace
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
git clone https://github.com/aYutaSekiguchi/gemini-termium.git
cd gemini-termium
npm install
npm run setup   # Downloads the Termium binary matching your OS / CPU
```

### Usage

Run from any project directory:

```bash
cd /path/to/my-project
npx gemini-termium
```

#### One-Time Google Login
On first launch, `gemini-termium` tries to reuse the Google login from your regular Chrome. If you are not signed in there (or Gemini shows a login page):

```bash
npx gemini-termium --login
```
A desktop window will open. Sign into your Google account once, then close the window. The login is saved to the master profile and reused by every project directory.

---

## ⚡ Slash Commands & Actions

| Command | Action |
| :--- | :--- |
| `/agent <task>` | Starts an autonomous coding session. Auto-scans workspace file tree and invokes Gemini Skill (default: `@pair-programmer`) with Human-in-the-Loop approval. |
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
