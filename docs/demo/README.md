# Demo assets

Place the recorded walkthrough here:

| File | Purpose |
| --- | --- |
| `maia-llm-demo.mp4` | 2-minute walkthrough (H.264/AAC, 1080p, < 20 MB) |
| `demo-poster.png` | First-frame poster used as the README thumbnail (1600×900) |

Steps:

1. Record: catalogue search → model detail → estimate → confirm → provisioning log
   → first answer → live cost meter → pause and release.
2. Export at 1080p with a visible cursor; keep it under 20 MB so the repository
   stays light (`ffmpeg -i raw.mov -vf scale=1920:-2 -crf 28 -preset slow maia-llm-demo.mp4`).
3. Grab a poster frame: `ffmpeg -i maia-llm-demo.mp4 -vf "select=eq(n\,30)" -vframes 1 demo-poster.png`.
4. Follow the HTML block in `README.md` to embed it; for GitHub, upload the MP4 as
   a release asset or issue attachment and link that URL, since GitHub does not
   play repository-hosted video.
