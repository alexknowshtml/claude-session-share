# claude-session-share

Render [Claude Code](https://claude.ai/code) JSONL session transcripts as styled HTML pages and upload to any S3-compatible storage for sharing.

## What it does

- Parses Claude Code `.jsonl` session files
- Renders a clean, readable HTML page with syntax-highlighted code, collapsible tool calls, thinking blocks, and image support
- Uploads to S3-compatible storage (AWS S3, DigitalOcean Spaces, Cloudflare R2, MinIO, etc.)
- Or writes the HTML locally with `--output`

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

## Privacy

Session files may contain private information. Review before sharing — especially sessions involving emails, credentials, or personal data.

## License

MIT
