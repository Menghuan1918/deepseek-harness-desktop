# Third-party notices

## deepseek-ai/deepseek-harness

This package carries no official source. The per-session Git worktree is this
repo's own feature; the official Host and client contracts it relies on are
listed below. Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Integration points:

- **Official session title** — `sessionTitle.refresh()` is used as the explicit
  entry point when the kernel's automatic title generation did not run, right
  after the first request header lands; its absence or failure never affects the
  task itself (`src/host/service/title.ts:21`,
  `src/host/events/session-event.ts:9`).
- **Official attachments service** — attachment descriptors are handed back to
  the official collection, and a missing capability only falls back, never
  blocks (`src/client/service/attachments.ts:5`,
  `src/client/service/attachments.test.ts:115`).
- **Official composer DOM** — send interception depends on the official
  composer's private DOM because no pre-submit hook exists
  (`src/client/components/mode-select.tsx:104`); file uploads wait for readiness
  exactly as the official composer disables send while it is not ready.
- **Ordinary session titles** — titles are refreshed once per session via the
  official entry, matching the kernel's own timing.

## License

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
