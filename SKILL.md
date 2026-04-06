---
name: session-share
description: Share a Claude Code session as a styled public HTML page. Accepts session ID, keyword search, or no args for latest session. Uploads to S3-compatible storage and returns a URL.
triggers:
  - "share this session"
  - "share that session"
  - "session share"
  - "share session"
  - "view transcript"
  - "render transcript"
  - "make a transcript"
  - "view session"
  - "render session"
  - "share a transcript"
---

# Session Share

Render a Claude Code JSONL session transcript as a styled HTML page and upload to S3-compatible storage for sharing.

## Command

```bash
bun /path/to/session-share.ts <path-to-jsonl>
```

Returns a public URL like `https://your-bucket.region.provider.com/public/transcript-<shortid>.html`

## Credentials

Set these environment variables before running:

```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_ENDPOINT_URL=https://your-region.provider.com   # omit for AWS S3
export AWS_REGION=your-region
export S3_BUCKET=your-bucket
export S3_PREFIX=public/
export S3_PUBLIC_URL=https://your-bucket.your-region.provider.com
```

Optionally, if your setup injects agent context into user messages, set the filter pattern:
```bash
export SESSION_SHARE_SYSTEM_FILTER="[YOUR-AGENT-MARKER]"
```

## Finding the Right Session

Sessions are JSONL files at:
```
~/.claude/projects/<project-slug>/<uuid>.jsonl
```

### No argument → Latest session
```bash
ls -t ~/.claude/projects/<project-slug>/*.jsonl | head -1
```

### Session ID prefix (e.g. "43a9e08c")
```bash
ls ~/.claude/projects/<project-slug>/43a9e08c*.jsonl
```

### Keyword search
Search session content for relevant text:
```bash
bun -e "
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const query = 'KEYWORD_HERE';
const base = join(homedir(), '.claude/projects');

function findJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findJsonl(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const results: [number, string, string][] = [];
for (const f of findJsonl(base)) {
  try {
    const content = readFileSync(f, 'utf8');
    if (!content.toLowerCase().includes(query.toLowerCase())) continue;
    let preview = '';
    for (const line of content.split('\n')) {
      try {
        const entry = JSON.parse(line);
        const c = entry?.message?.content;
        let text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter((b:any) => b.type==='text').map((b:any) => b.text).join('') : '';
        if (text.toLowerCase().includes(query.toLowerCase())) {
          preview = text.slice(0, 80).replace(/\n/g, ' ');
          break;
        }
      } catch {}
    }
    results.push([statSync(f).mtimeMs, basename(f).slice(0, 8), preview]);
  } catch {}
}
results.sort((a, b) => b[0] - a[0]);
for (const [t, id, preview] of results.slice(0, 5)) {
  const dt = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  console.log(id + '  ' + dt + '  ' + preview.slice(0, 60));
}
"
```

## Rendering

Once you have the JSONL path:
```bash
bun /path/to/session-share.ts /path/to/session.jsonl
```

Output includes the public URL.

## Local output (no upload)

To write HTML locally without uploading:
```bash
bun /path/to/session-share.ts /path/to/session.jsonl --output session.html
```

## Credential Safety

Bash blocks containing credentials are **automatically suppressed** — replaced with a "🔒 hidden — contained sensitive data" placeholder. This is the default behavior.

To render them with a danger warning (for local review only):
```bash
bun /path/to/session-share.ts /path/to/session.jsonl --show-sensitive-bash --output review.html
```

`--show-sensitive-bash` forces `--output` mode — upload is blocked when sensitive commands are present.

## Privacy Note

Always review sessions before sharing — especially sessions involving emails, credentials, or personal data.
