# TeX64 — 60-second Marketing Video

**Target**: LaTeX users / researchers
**Tone**: Cool, technological, confident
**Language**: English (narration + on-screen text)
**Voice**: AI (ElevenLabs recommended — male, neutral, ~155 wpm, slightly authoritative)
**Format**: 9:16 vertical (primary) + 1:1 square (derivative) for X/Twitter
**Resolution**: 1080×1920 (vertical) / 1080×1080 (square)
**Total length**: 60 seconds

---

## Visual & narrative direction

- Dark background dominant (matches "cool / technological" tone)
- Type-driven aesthetic — let LaTeX glyphs and math be the hero
- Hard cuts, no soft fades (tech feel)
- Cursor movements should feel deliberate, not jittery — record slowly and we'll speed-ramp in post
- One on-screen English word/phrase per scene, big, in a monospaced or scientific serif (e.g. `Computer Modern`, `JetBrains Mono`)
- Subtle accent color: a single signal color (recommend `#7DF9FF` cyan or `#FF6B35` orange) used sparingly for emphasis

---

## Script + storyboard (60 sec)

| Time | Visual | On-screen text | Narration |
|---|---|---|---|
| 0:00–0:03 | Black. A LaTeX equation slowly types itself: `\int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}` | — | *(silence, then beat drop)* |
| 0:03–0:07 | Cut to TeX64 splash → app opens, shows the main editor | **TeX64** | "Your LaTeX. Faster." |
| 0:07–0:13 | Screen recording: typing in editor → live PDF preview updates on the right | Live preview | "Native. Local. Instant." |
| 0:13–0:20 | Screen recording: invoke OCR — drop an image of a handwritten equation, watch it convert to clean LaTeX source | Image → LaTeX | "Drop an image. Get the source." |
| 0:20–0:27 | Screen recording: paste rich HTML / a Word snippet → it becomes formatted LaTeX | HTML → LaTeX | "Paste from anywhere. It just works." |
| 0:27–0:34 | Screen recording: switching build profiles (pdflatex / xelatex / lualatex), build completes in seconds | Multi-engine | "pdfLaTeX. XeLaTeX. LuaLaTeX. Yours to choose." |
| 0:34–0:41 | Screen recording: error click in the bottom panel jumps to the exact line; auto-format cleans up the source | Smart errors | "Errors that take you to the line. Formatting that just runs." |
| 0:41–0:48 | Quick montage (0.6s each): sidebar tree, search, settings, dark theme, multi-tab | — | "Built for serious writing." |
| 0:48–0:54 | Hero shot: clean 2-column scientific PDF rendered next to the source | For papers. For theses. For research. | "For the work that matters." |
| 0:54–0:60 | Logo card. URL appears. | **TeX64** &nbsp;&nbsp;·&nbsp;&nbsp; tex64.com | "TeX64. LaTeX, the way it should be." |

**Word count**: ~62 words → ~24 seconds of pure narration. The rest is breathing room, music, and ambient screen sounds. This is intentional — tech-tone videos work better when narration is sparse.

---

## Shot list (what you need to record)

Capture at **1920×1080 minimum** (we'll crop to 9:16). Use **QuickTime Player → File → New Screen Recording** (`⌘⇧5`). Each clip can be ~5–10s; we'll trim.

1. **Cold-open equation typing** — *I will generate this in post (no recording needed).*
2. **App launch** — open TeX64 from a clean desktop. ~3s.
3. **Editor + live preview** — type a few lines of math, watch PDF update on the right. ~10s.
4. **OCR demo** — drag a PNG/JPG of a handwritten or printed equation onto the OCR feature, show the resulting LaTeX. ~10s. *(If we don't have a slick OCR moment, skip — but this is the killer demo.)*
5. **HTML-to-LaTeX** — copy a rich snippet (e.g. from a Wikipedia article) and paste it into TeX64; show the formatted LaTeX output. ~8s.
6. **Build profile switch** — open build profiles, switch engines (pdflatex → xelatex → lualatex), run a build. ~8s.
7. **Error-jump + auto-format** — make a syntax error, click the error in the bottom panel, watch cursor jump; then run latexindent / auto-format. ~10s.
8. **Quick UI montage** — sidebar tree expanding, search panel, settings, multi-tab, dark theme. 5 micro-clips of ~1s each.
9. **Hero PDF** — final rendered 2-column scientific PDF, slow scroll. ~5s.
10. **Logo / outro card** — *I will generate in post.*

**Recording tips**: hide irrelevant windows, use a clean filename like `paper.tex`, keep cursor movements slow and intentional, no double-clicks or hesitation. Disable notifications (`Do Not Disturb`). Use a sample document that looks like a real paper, not "hello world".

---

## Audio plan

- **Narration**: AI voice (ElevenLabs `Adam` or `Brian` — neutral, confident, slightly low). I'll generate the WAV from the script.
- **BGM**: Looking for a tech / minimal / synth bed. Recommended free sources:
  - [Pixabay Music](https://pixabay.com/music/) — search "tech minimal", "tech logo", "ambient tech"
  - Specific tracks worth considering: "Cyber" / "Tech Future" / anything ~120 BPM minimal
- **SFX**: very subtle — a soft "tick" on each cut, a "whoosh" only on the logo reveal. I'll source from freesound.org if needed.
- **Mix**: narration -3 dB, BGM -18 dB (sidechain ducked under narration), SFX -12 dB.

---

## Delivery formats (final outputs)

- `tex64_60s_9x16.mp4` — 1080×1920, H.264, 30fps, ~6 Mbps (Twitter/X feed)
- `tex64_60s_1x1.mp4` — 1080×1080, H.264, 30fps (Twitter/X timeline)
- `tex64_60s_subtitles.srt` — English captions for accessibility (Twitter often plays muted)

---

## What I need from you (next step)

1. Review/edit this script — change wording or features you want highlighted
2. Confirm the AI voice direction (ElevenLabs requires a paid plan; alternatives: Play.ht, Coqui, macOS `say`)
3. Confirm the visual accent color
4. Record clips 2–9 from the shot list above and drop them in `/Users/wedd/tex64-internal/marketing-video/raw/`
5. Tell me which BGM track to use (or let me pick from Pixabay)

Once I have raw footage + voice direction + BGM, I'll cut the full video.
