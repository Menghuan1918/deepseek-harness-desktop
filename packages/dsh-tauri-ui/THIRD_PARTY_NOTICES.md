# Third-party notices

## deepseek-ai/deepseek-harness

Parts of this package are a Tauri-flavoured refork of the official client UI.
Official components are re-exported as-is where both kernel generations agree,
and reforked locally where only the newer kernel implements or exports them.
Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Derived files and contracts (upstream → this package):

| Upstream | This package | What was taken |
| --- | --- | --- |
| `packages/client/ui-primitives/src/` (version `0.1.7-alpha.1`, ≥ `0.1.5-rc.1`) | `src/client/components/official.tsx` | Pass-through re-export of the official primitives (`Button`, `Switch`, `Tag`, `Pill`, `Menu`, `Input`, `Tooltip`, `Toast`, `Modal`, `HoverCard`, `DisclosureRow`, `StateDot`, `ConnectionIndicator`, `BrandWordmark`, `FishLogo`). `Button` / `Tag` are taken over per-variant by `button.tsx` / `tag.tsx` (official variant → official implementation, local variant → refork style). The official icons barrel is deliberately **not** re-exported (export names differ between kernel generations). |
| `packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css` → `PluginManagerPage` page root geometry | `src/client/ui/panel-page.cssr.ts`, `src/client/ui/panel-page.tsx` | The third-party plugin panel is laid out line-by-line on the official plugin page geometry. |
| `packages/client/ui-sidebar`, `ui-workspace`, `ui-chat`, `ui-settings-models`, `ui-agent-preset`, `ui-permission-presets`, `ui-goal` CSS Modules | `src/client/components/registry.ts` (`UI_COMPONENT_REGISTRY`, `kind: 'reexport' \| 'refork'`, `mappedClass`), `src/client/components/*.cssr.ts` | Reforked component geometry and official class mapping; official `.module.css` files are not copied, the geometry is reproduced on this repo's `css-render` stack. |
| Official sidebar branding row and its collapse toggle (`global.cssr.ts` notes: the official toggle duplicates the shell navbar entry) | `src/client/styles/global.cssr.ts` | Hiding rule for the duplicated official entry, keyed off the official class shape (`clsx(brand, wide)`) and `aria-label` dictionaries instead of hashed class names. |
| Official slot `conversation.hero.workspace` (single/root, declared by `ui-workspace`, official `WorkspacePicker` at default priority) | `src/client/register/hero-workspace.ts`, `src/client/ui/hero-workspace.*` | Takeover at a lower priority so the official registration stays in place and the official picker returns when this entry steps aside; the official `WorkspacePickFlow` "add workspace" item id is reused verbatim. |
| Official settings launcher seat (`ui-settings-general` `SettingsRoot` rendering the account menu) | `src/client/constants/index.ts` (`SETTINGS_TRIGGER_PRIORITY`), `src/client/ui/trigger.tsx` | Seat takeover that must keep a host for the official account UI, plus the official dictionary strings for the sidebar "new session" button and the ungrouped workspace-group `+` (`new-session.utils.ts`), and the official `UNGROUPED_KEY`. |
| Official reference chips (`ctx.conversation.input` insertion path) | `src/client/register/paste-collapse.ts` | Large pastes collapse into the official reference chip through the official public surface only. |
| Official primitives variants `PermissionRow.selector`, `PermissionSelect`, `AgentPresetSeat` | `src/client/components/chip.tsx` | Per-variant wrapping and the official `@container` query that `css-render` can only emit as a top-level raw rule. |

No official source file is vendored; every refork reproduces official geometry,
class mapping, slot contracts and dictionary strings so both sides stay
compatible across kernel versions.

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
