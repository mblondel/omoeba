# Omoeba

Manage a local library of PDFs. PDFs can have inline annotations, Markdown notes, tags and AI summaries.

Built with Electron, TypeScript, pdf.js and KaTeX (see `spec.md`).

## Getting started

```sh
npm install
npm start        # builds into dist/ and launches Electron
```

On first launch, choose one or more library folders and the AI command-line tools you authorize.
Settings are saved in `~/omoeba/config.json`. More folders can be added later (Settings, or File → Add Library Folder…).

## Files

Omoeba never moves or renames your PDFs. Next to each `paper.pdf` it may create:

| File         | Content                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `paper.skim` | Annotations, in Skim's format (binary plist of note dictionaries). Readable/writable by Skim. |
| `paper.json` | Title, authors, institutions, tags, notes, summaries (one per AI, images as base64), download location, Ask-AI chats. |

A `.json` with `"omoeba": 1` and no PDF is shown as a paper whose PDF is missing; it can be downloaded again from
its original location. Unknown keys in `.json` and `.skim` files are preserved.

In `~/omoeba/`: `config.json` (settings), `index.json` (search index cache), `ai-workdir/` (empty directory in which AI CLIs run).

## AI

Only AIs with a command-line interface are used, and only those authorized in Settings. Presets:

| AI           | Command                                                   |
| ------------ | --------------------------------------------------------- |
| Claude Code  | `claude -p --output-format text`                          |
| OpenAI Codex | `codex exec --skip-git-repo-check --sandbox read-only -`  |
| Gemini CLI   | `gemini`                                                  |

The prompt (with the paper's text extracted by pdf.js) is written to the command's standard input, or substituted
for `{prompt}` if it appears in the arguments. Custom AIs can be added in Settings. The login-shell `PATH` is used,
so tools installed with Homebrew/npm are found when the app is launched from the Dock.

When a paper is opened and "automatically extract" is on, the default AI extracts title, authors, institutions,
year, venue, abstract and keywords, and writes a summary, if these are missing. Results are cached in the `.json`.
Summaries may include figures: the AI references a page (`![caption](page:N)`) which is rendered and embedded.

## Search

The list's search box queries a reverse index (tags, authors, institutions, keywords, titles, summaries, notes and the
first pages of each PDF), synchronized in a background worker thread at startup, on file changes and every N minutes.

```
diffusion            any field, prefix match
author:bengio        also a:
inst:mila            also institution:, i:
tag:"to read"        also t:
kw:rl  title:flow    keyword, title
folder:gflow         folder name
-tag:read            exclude
```

## Reader shortcuts

| Key                     | Action                                |
| ----------------------- | ------------------------------------- |
| ⌘F                      | Find in document                      |
| ⌘⌥1 / ⌘⌥2               | Toggle left / right pane              |
| ⌘+ / ⌘- / ⌘0, pinch     | Zoom                                  |
| h, u, n, t              | Highlight, underline, note, text tool |
| Delete                  | Delete the selected annotation        |
| Esc                     | Close find / tool / back to paper     |

Selecting text shows a popup to highlight (5 colors), underline, strike out, or ask the AI about the passage.

## Development

```sh
npm run watch      # rebuild on change (then reload the window with ⌘R)
npm test           # unit tests (.skim codec, sidecars, search index, …)
npm run typecheck
```

Layout: `src/main` (Electron main process, index worker, `.skim`/plist codec, AI runner), `src/renderer` (UI),
`src/shared` (types shared over IPC). The renderer is served from a privileged `app://` scheme and talks to the
main process only through the API in `src/shared/types.ts` (`window.omoeba`).
