# AGENTS.md

## Google Gemini Terms of Service Compliance Policy

### Human-in-the-Loop Requirement: Mandatory Human Trigger

**All prompt submissions, tool executions, and replies back to Google Gemini MUST be explicitly triggered and confirmed by a human user.** Fully autonomous background loops that interact with or send prompts to the Gemini Web UI without direct human action are strictly prohibited.

#### Rationale
Automating the Gemini Web UI via programmatic, unprompted loops violates Google's Terms of Service and triggers Google's anti-abuse and bot detection mechanisms (BotGuard / reCAPTCHA Enterprise). To maintain compliance and service integrity, this tool operates strictly as a human-assisted bridge, where the user retains ultimate agency over every action.

#### Policy Rules:
1. **Explicit Human Confirmation for Every Tool Call**:
   When Gemini outputs a tool invocation template (`%<tool_call>%`, `%<read>%`, `%<write path="...">%`), the tool execution and subsequent response generation MUST pause until the human user explicitly reviews the action and confirms it (e.g., pressing `[y]`).
2. **Human-Triggered Reply**:
   The reply payload containing the tool execution result (`%<tool_result>%...%</tool_result>%`) is submitted back to the Gemini Web UI ONLY as a direct consequence of the user's manual approval. The system must NEVER automatically post replies in an unconstrained background loop.
3. **Editable / Cancellable Actions**:
   The user must always be provided with the option to cancel (`[n]`) or reject a tool call before any local file changes or command execution occur.
4. **Local Workspace Isolation**:
   All file reads and writes are strictly confined within the active workspace root directory (`process.cwd()`). Path traversal outside the workspace boundary is prevented.

---

## Agent Mode Design

### 1. Tool Call Markup Formats
Gemini is instructed via prompt to use explicit markup tags when requesting local actions:
- **Command Execution**: `%<tool_call>%command%</tool_call>%`
- **File Read**: `%<read>%file/path%</read>%`
- **File Write / Patch**: `%<write path="file/path">%content%</write>%`

When Gemini emits one of these tags, it halts further generation and awaits the user's result.

### 2. Approval & Trigger Workflow
1. **Parse**: In-page observer detects complete tool call tags in Gemini's response.
2. **Prompt User**: A prominent modal/HUD prompt displays the action details (command line, file path, diff/content preview).
3. **User Decision**:
   - `[y]` (Approve): Executes action locally, formats `%<tool_result>%...%</tool_result>%`, and types/submits reply to Gemini.
   - `[n]` (Reject): Informs Gemini that the user declined the action or allows user to provide manual input.
4. **Audit Log**: All executed commands and file modifications are logged clearly to the session console drawer.
