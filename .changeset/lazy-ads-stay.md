---
"drawcast": major
---

Move voice generation out of Drawcast. Use `drawcast narration export` and your preferred TTS tool to produce WAVs and a result JSON, then pass `--narration` to render or snapshot. Remove built-in voices, MiniMax key management, speech models, and the voice, speed, and TTS command options.
