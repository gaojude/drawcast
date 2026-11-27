# Drawcast

Your coding agent can turn an explanation into a narrated whiteboard video. Paste this prompt into your agent:

```text
Install the Drawcast skill with `npx -y skills add gaojude/drawcast -g -y` and run `npx -y drawcast@latest setup`. Use the skill to make a short video explaining DNS with the built-in maple voice. Verify the MP4 and show it to me.
```

The built-in voice synthesizes narration on your machine. Setup downloads the speech model and any missing rendering tools.

## Optional MiniMax voices

Already use MiniMax? Set `MINIMAX_API_KEY` in your agent's environment or secret manager, then ask your agent to use a MiniMax voice for the video. Keep the key out of chat. Selecting a MiniMax voice sends the narration to MiniMax and bills your account by the character. With only the key configured, narration stays local by default.
