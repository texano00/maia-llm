# Demo assets

The README embeds `maia-llm-demo.gif` (GitHub plays GIFs inline but not
repository-hosted MP4) and links the MP4 for the full-quality version.

| File | Purpose |
| --- | --- |
| `maia-llm-demo.mp4` | 14 s highlight, 2× speed, H.264, no audio, ~0.7 MB |
| `maia-llm-demo.gif` | Same clip at 12 fps / 880 px, inline in the README (~1.8 MB) |
| `demo-poster.png` | Still frame used wherever a static image is needed |

How the current clip was made from the raw screen recording (2 m 18 s):

```bash
# four windows, each played at 2× and concatenated: estimate → boot → chat
ffmpeg -i recording.mp4 -filter_complex "\
  [0:v]trim=5.5:11.5,setpts=(PTS-STARTPTS)/2[a];\
  [0:v]trim=12:16.5,setpts=(PTS-STARTPTS)/2[b];\
  [0:v]trim=111:116,setpts=(PTS-STARTPTS)/2[c];\
  [0:v]trim=126:138,setpts=(PTS-STARTPTS)/2[d];\
  [a][b][c][d]concat=n=4:v=1:a=0[v]" -map "[v]" -an \
  -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p -movflags +faststart \
  docs/demo/maia-llm-demo.mp4

# inline GIF
ffmpeg -i docs/demo/maia-llm-demo.mp4 -vf \
  "fps=12,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 docs/demo/maia-llm-demo.gif
```

Keep the highlight under 15 s: longer clips are not watched. Skip the catalogue
rows that are not chat models, and never include a key or account name.
