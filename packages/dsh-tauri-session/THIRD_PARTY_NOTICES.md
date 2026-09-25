# Third-party notices

## deepseek-ai/deepseek-harness

This package carries no official source. It extends the official workspace
browser and settings sidebar through official slots, official primitives
`Menu` entries and the official sessions / workspaces service surfaces.
Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Integration points:

- **Archive entry** — the official primitives menu item for "delete workspace"
  is cloned into an "archive workspace" entry inserted before the official item,
  which stays at the bottom of the menu
  (`src/client/register/workspace-patch.tsx:25-29`,
  `src/client/register/workspace-patch.utils.ts:52,63-64`). The official danger
  entry styling is overridden back to a neutral menu item through a plugin
  attribute hook plus `!important`
  (`src/client/styles/workspace-menu.cssr.ts:6`).
- **Official row/menu recognition** — only official `itemWrap`-structured
  primitives entries are recognised, and workspace rows are matched by the
  official row title (`workspace-patch.utils.ts:13,32,52`).
- **Official service surface** — `src/client/types/runtime.ts:24-29` declares the
  official sessions (list subscription, refresh, open, bind, fork) and workspaces
  service surfaces; `open` moved in kernel 0.1.7 and is restored by this repo's
  adapter instead of being re-implemented here.
- **Official archive action mirroring** — a session archived through the official
  menu must appear in this package's page immediately, so the archive view
  mirrors the official action (`src/client/hooks/use-archive-view.ts:15`).
- **Official row disabled** — `cordis.patch.yml` disables the official row id
  `ui-settings-unarchive-sessions`: that official settings page duplicates this
  package's archive section and only supports unarchive, never delete.

Deliberate difference: the official entry only unarchives; this package's
"Archived chats" page adds search, sort, grouping, project filter, delete and a
"delete workspace" action rewritten into "archive workspace".

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
