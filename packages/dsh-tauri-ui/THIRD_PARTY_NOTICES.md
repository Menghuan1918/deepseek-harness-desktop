# Third-party notices

## deepseek-ai/deepseek-harness

This package re-forks individual UI components and their styles from the upstream
client UI packages. Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `477b4f420553e8a52c2fbccc464d7561b239c443` (`dsh-v0.1.7-rc.2`,
  the revision vendored at `source/deepseek-harness`)
- License: MIT — Copyright (c) 2026 DeepSeek

Derived components (upstream class → this package), with the upstream source
tracked per file in the `引用源` header and in `src/client/components/registry.ts`:

| Upstream | This package (`src/client/`) | What was taken |
| --- | --- | --- |
| `ui-primitives` — `Button`, `Switch`, `Tag`, `Pill`, `Menu`, `Input`, `Tooltip`, `Toast`, `Modal`, `HoverCard`, `DisclosureRow`, `StateDot`, `ConnectionIndicator`, `BrandWordmark`, `FishLogo` | `components/official.tsx` (re-export) | The official components are re-exported unchanged where the locked primitives already ship them in both supported cores. |
| `ui-primitives` — `Checkbox.tsx`, `StateDot.module.css` (dot), `settings-form/fields.module.css` (helpButton) | `components/checkbox.tsx`, `dot.tsx`, `icon-button.tsx` + `.cssr.ts` | Geometry, ink, and focus ring, re-implemented on this repo's `css-render` stack. |
| `ui-sidebar` — `SidebarRoot.module.css` (`newSession`, `iconButton`) | `components/button.tsx`, `icon-button.tsx` + `.cssr.ts` | The New Session capsule and the rail/toolbar icon buttons. |
| `ui-plugin-manager` — `PluginManagerPage.module.css` (`addButton`, `danger`, `iconButton`, `versionTag`, `statusTag`) | `components/button.tsx`, `icon-button.tsx`, `tag.tsx` + `.cssr.ts` | The card actions, the destructive action's token rebinding, and the version/status tags. |
| `ui-workspace` — `rows/WorkspaceBrowser.module.css` (`searchButton`, `iconButton`), `rows/Rows.module.css` (`iconButton`) | `components/icon-button.tsx` + `.cssr.ts` | Browser and row icon buttons. |
| `ui-settings-models` — `ModelsSection.module.css` (`iconButton`) | `components/icon-button.tsx` + `.cssr.ts` | The models-page icon action. |
| `ui-chat` — `chat/MessageIconActions.module.css` (`action`) | `components/icon-button.tsx` + `.cssr.ts` | The message action strip button. |
| `ui-agent-preset` — `AgentPresetSeat.module.css` (`seat`) | `components/chip.tsx` + `.cssr.ts` | The agent-preset seat chip. |
| `ui-permission-presets` — `PermissionSelect.module.css` (`trigger`), `PermissionRow.module.css` (`selector`) | `components/chip.tsx` + `.cssr.ts` | The permission picker's trigger and row selector. |
| `ui-goal` — `GoalBar.module.css` (`bar`, `iconBtn`) | `components/goal-bar.tsx` + `.cssr.ts` | The goal bar and its icon action. |
| `ui-theme` — `base.css` radius scale, `focus.css` focus ring | `client/constants/theme.ts` | Token names only: the components consume `--dsw-radius-*` and the focus-ring tokens, with literal fallbacks for cores that predate them. |

Not derived (this repo's own glue): `client/ui/` (settings sidebar, trigger,
segmented control, hero workspace, nav icon, panel page), `client/styles/`,
`client/register/`, `client/service/`, `client/store/`, `client/apis/`,
`client/types/`, `client/host/`, and the model-configuration extras under
`client/ui/model-extras/`.

Synced from upstream `0.1.7-alpha.1` → `0.1.7-rc.2`:

- The radius scale replaces the previous fixed capsules (`50%`, `28px`, `24px`,
  `18px`, `16px`, `14px`, `12px`, `6px`, `4px`) on every reforked class listed
  above; the focus ring moves from the border token to
  `--dsw-focus-ring-color` with `--dsw-alias-state-business-primary` as fallback.
- `Checkbox` adopts the upstream metrics (`gap: 6px`, `line-height: 20px`).
- The sidebar rail's logo lives inside the collapse toggle
  (`SidebarRoot.module.css` — `railMark`), so `styles/global.cssr.ts` keeps that
  toggle visible while collapsed and hides it only in the expanded layout.
- The settings launcher passes the new `settingsOpen` owner prop the official
  account menu uses to refresh on open.

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
