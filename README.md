# claude-session-share

Render [Claude Code](https://claude.ai/code) JSONL session transcripts as styled HTML pages and upload to any S3-compatible storage for sharing.

**[Live demo →](https://jfdi.bot/session-demo)**

## What it does

- Parses Claude Code `.jsonl` session files
- Renders a clean, readable HTML page with syntax-highlighted code, collapsible tool calls, thinking blocks, and image support
- Uploads to S3-compatible storage (AWS S3, DigitalOcean Spaces, Cloudflare R2, MinIO, etc.)
- Or writes the HTML locally with `--output`
- Sensitive bash commands (credentials, tokens) are suppressed automatically — nothing leaks to the rendered page

## Requirements

- [Bun](https://bun.sh) v1.0+

## Setup

```bash
git clone https://github.com/alexknowshtml/claude-session-share
cd claude-session-share
bun install
```

## Usage

```bash
# Interactive session picker
bun session-share.ts

# Render a specific session
bun session-share.ts ~/.claude/projects/my-project/abc123.jsonl

# Write to local file instead of uploading
bun session-share.ts ~/.claude/projects/my-project/abc123.jsonl --output session.html
```

## Upload Configuration

Set these environment variables to enable S3 upload:

| Variable | Required | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Yes | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | S3 secret key |
| `S3_BUCKET` | Yes | Bucket name |
| `AWS_ENDPOINT_URL` | No | Custom endpoint for non-AWS providers |
| `AWS_REGION` | No | Region (default: `us-east-1`) |
| `S3_PREFIX` | No | Key prefix (default: `public/`) |
| `S3_PUBLIC_URL` | No | Override the public URL base |
| `SESSION_SHARE_SYSTEM_FILTER` | No | String pattern marking agent-injected system messages (see below) |

### DigitalOcean Spaces example

```bash
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret
export AWS_ENDPOINT_URL=https://nyc3.digitaloceanspaces.com
export AWS_REGION=nyc3
export S3_BUCKET=your-bucket
export S3_PUBLIC_URL=https://your-bucket.nyc3.digitaloceanspaces.com

bun session-share.ts ~/path/to/session.jsonl
```

### AWS S3 example

```bash
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret
export AWS_REGION=us-east-1
export S3_BUCKET=your-bucket

bun session-share.ts ~/path/to/session.jsonl
```

## Session files

Claude Code stores session transcripts as JSONL files at:

```
~/.claude/projects/<project-slug>/<uuid>.jsonl
```

The interactive picker shows recent sessions sorted by modification time.

## What gets rendered

- User messages and assistant replies
- Tool calls (Read, Write, Bash, etc.) — collapsed by default, expandable
- Tool results — collapsible with OK/error styling
- Thinking blocks — collapsed by default
- Skill/command expansions — collapsed with label
- Images shared in the session
- Code with syntax highlighting

## System message filtering

If your Claude Code setup injects agent context into user messages (e.g. a Discord bridge that wraps messages with a task header), set `SESSION_SHARE_SYSTEM_FILTER` to the marker string used in those injections. The renderer will extract the actual human message from the `**Message:**` field and hide the surrounding system context.

```bash
# Example: messages containing this pattern are treated as agent-injected context
export SESSION_SHARE_SYSTEM_FILTER="[MY-AGENT-TASK]"
```

If unset, all user messages are rendered as-is.

## Credential safety

### How credentials end up in sessions

Claude Code records every tool call in the session JSONL file — including bash commands. If Claude runs a command like:

```bash
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE && aws s3 ls
```

that literal string is stored in the transcript. The same applies to any bash command that sets sensitive env vars inline.

Credentials can appear in multiple places in a session:

- **Bash inputs** — commands Claude wrote that include `KEY=value`, `TOKEN=value`, etc.
- **Bash outputs** — if a script printed a credential value, ran `env | grep KEY`, or echoed a secret
- **Write/Edit blocks** — if Claude wrote a file containing credentials (e.g. a `.env` file with real values)
- **Read blocks** — if Claude read a file containing credentials and the content was captured

### What's handled automatically

**Bash inputs are scanned and suppressed by default.** Any bash command containing an env var assignment where the name includes `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, or `CREDENTIAL` is replaced with a `🔒 hidden — contained sensitive data` placeholder before rendering. Nothing from those commands reaches the HTML.

Examples of what's caught: `AWS_ACCESS_KEY_ID=...`, `GITHUB_TOKEN=...`, `DB_PASSWORD=...`, `STRIPE_SECRET_KEY=...`

### What's NOT handled automatically

The auto-detection only covers bash input patterns. It does **not** catch:

- Credentials in **bash outputs** (tool results from running commands)
- Credentials in **Write/Edit/Read** tool blocks
- Credentials passed as **positional CLI arguments** (e.g. `my-tool --key=abc123`)
- Credentials that appear in **assistant text** responses

### Recommended workflow

Always preview locally before uploading, especially for sessions that involved credentials, `.env` files, or API setup:

```bash
# 1. Render locally first
bun session-share.ts session.jsonl --output review.html

# 2. Open and inspect
open review.html   # or xdg-open on Linux

# 3. Upload only if satisfied
bun session-share.ts session.jsonl
```

### Reviewing suppressed bash commands

To see suppressed commands with a danger warning (local review only):

```bash
bun session-share.ts session.jsonl --show-sensitive-bash --output review.html
```

Upload is blocked when `--show-sensitive-bash` is used — `--output` is required.

## Privacy

Session files may contain private information — emails, personal data, API keys, internal tooling details. Review before sharing. Use `--output` to save locally first and inspect before uploading.

## License

MIT
