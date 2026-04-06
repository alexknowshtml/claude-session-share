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
python3 -c "
import json, glob, os

query = 'KEYWORD_HERE'
results = []
for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
    try:
        with open(f) as fh:
            content = fh.read()
        if query.lower() in content.lower():
            mtime = os.path.getmtime(f)
            for line in content.splitlines():
                entry = json.loads(line)
                text = ''
                c = entry.get('message', {}).get('content', '')
                if isinstance(c, str): text = c
                elif isinstance(c, list):
                    for b in c:
                        if b.get('type') == 'text': text += b.get('text', '')
                if query.lower() in text.lower():
                    preview = text[:80].replace('\n', ' ')
                    break
            results.append((mtime, os.path.basename(f)[:8], f, preview))
    except: pass
results.sort(reverse=True)
for mtime, sid, path, preview in results[:5]:
    from datetime import datetime
    dt = datetime.fromtimestamp(mtime).strftime('%b %d')
    print(f'{sid}  {dt}  {preview[:60]}')
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
