import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

/**
 * SSH-machines settings section styles (css-render tree, mounted once by the
 * client apply through ctx.effect). Ported 1:1 from the former CSS Modules
 * sheet: the official primitives (Button / Input / StateDot / Modal / Pill)
 * draw the controls; this tree keeps only layout and token alignment —
 * 14/22 body, 12/18 caption, hairline `border-l2` cards, and the few custom
 * visuals the primitives do not own (the hollow idle dot, the color
 * swatches, the tint switch). Every color resolves through a `--dsw-alias-*`
 * token, so light and dark themes both work without literals.
 *
 * Class names are flat with the plugin prefix (`dshp-ssh-*`); the TSX side
 * consumes them through the `cls` map in `./index.ts` — never hand-write the
 * prefixed strings in components.
 */
export default c([

  c('.dshp-ssh-section', {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '760px',
    color: 'var(--dsw-alias-label-primary)',
  }),

  c('.dshp-ssh-title', {
    margin: 0,
    fontSize: '18px',
    lineHeight: '28px',
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  }),

  c('.dshp-ssh-intro', {
    margin: 0,
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  /* The section head: title/intro left, page actions right. */
  c('.dshp-ssh-section-head', {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
  }),

  /* The page chrome: refresh / add. */
  c('.dshp-ssh-chrome', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    flexShrink: 0,
  }),

  /* The danger seat of an otherwise primitive button (token-aligned color). */
  c('.dshp-ssh-danger-action', {
    color: 'var(--dsw-alias-state-error-primary)',
  }),

  /* The step rail: compact phase chips of the in-flight operation. */
  c('.dshp-ssh-step-rail', {
    display: 'inline-flex',
    gap: '4px',
    margin: '0 0 0 8px',
    padding: 0,
    listStyle: 'none',
    verticalAlign: 'middle',
  }),
  c('.dshp-ssh-step-done', {
    fontSize: '11px',
    lineHeight: '16px',
    padding: '0 6px',
    borderRadius: '999px',
    color: 'var(--dsw-alias-label-tertiary)',
    border: '1px solid var(--dsw-alias-line-secondary, currentColor)',
  }),
  c('.dshp-ssh-step-current', {
    fontSize: '11px',
    lineHeight: '16px',
    padding: '0 6px',
    borderRadius: '999px',
    color: 'var(--dsw-alias-state-warning-primary, #d48806)',
    border: '1px solid currentColor',
  }),

  /* The machine list: one surface, hairline dividers between rows. */
  c('.dshp-ssh-rows', {
    listStyle: 'none',
    margin: '12px 0 0',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '12px',
    background: 'var(--dsw-alias-bg-layer-3)',
    overflow: 'hidden',
  }),

  /* The read-only ~/.ssh/config group header. */
  c('.dshp-ssh-group', {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    marginTop: '12px',
  }),

  c('.dshp-ssh-group-title', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  }),

  c('.dshp-ssh-group-hint', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  c('.dshp-ssh-row-card', {
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    /* tintBorder 的机器：左侧 2px 标识色条（inline style 上色）。 */
    borderLeft: '2px solid transparent',
  }, [
    c('& + &', {
      borderTop: '1px solid var(--dsw-alias-border-l2)',
    }),
  ]),

  c('.dshp-ssh-row-head', {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  }),

  c('.dshp-ssh-row-identity', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  }),

  c('.dshp-ssh-row-name', {
    fontSize: '14px',
    lineHeight: '22px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
  }),

  /* The host as a pill annotation on the name (the settings badge idiom). */
  c('.dshp-ssh-row-tag', {
    flex: 'none',
    padding: '2px 8px',
    border: 'none',
    borderRadius: '999px',
    background: 'var(--dsw-alias-bg-module-platform)',
    fontSize: '11px',
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
  }),

  /* Connection state caption text (the dot itself is StateDot). */
  c('.dshp-ssh-status', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  /* The hollow idle dot: the one connection state StateDot has no glyph for. */
  c('.dshp-ssh-state-dot', {
    position: 'relative',
    display: 'inline-block',
    flex: 'none',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'currentColor',
    color: 'var(--dsw-alias-label-caption)',
  }, [
    c('&::after', {
      content: '\'\'',
      position: 'absolute',
      inset: '25%',
      borderRadius: '50%',
      background: 'currentColor',
    }),
  ]),

  /* Identity color pip next to the machine name. */
  c('.dshp-ssh-color-pip', {
    display: 'inline-block',
    flex: 'none',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 12%)',
  }),

  /* The appearance row: swatches + the tint-border switch. */
  c('.dshp-ssh-appearance', {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
  }),

  c('.dshp-ssh-swatches', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  }),

  c('.dshp-ssh-swatch', {
    boxSizing: 'border-box',
    width: '20px',
    height: '20px',
    padding: 0,
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '50%',
    background: 'var(--swatch-color)',
    cursor: 'pointer',
  }, [
    c('&:hover', {
      borderColor: 'var(--dsw-alias-border-l4)',
    }),
    c('&[data-selected=\'true\']', {
      outline: '2px solid var(--dsw-alias-brand-primary)',
      outlineOffset: '2px',
    }),
  ]),

  /* The "default" reset swatch: hollow with a diagonal strike. */
  c('.dshp-ssh-swatch-none', {
    background: 'linear-gradient(to top right, transparent calc(50% - 1px), var(--dsw-alias-label-tertiary), transparent calc(50% + 1px))',
  }),

  c('.dshp-ssh-switch-row', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    marginLeft: '4px',
  }),

  /* The hand-rolled toggle (the SubagentModelSelectionCard vocabulary). */
  c('.dshp-ssh-switch', {
    position: 'relative',
    width: '36px',
    height: '20px',
    padding: 0,
    border: 'none',
    borderRadius: '10px',
    background: 'var(--dsw-alias-border-l3)',
    cursor: 'pointer',
    transition: 'background 0.15s var(--ds-ease-in-out)',
  }, [
    c('&::after', {
      content: '\'\'',
      position: 'absolute',
      top: '2px',
      left: '2px',
      width: '16px',
      height: '16px',
      borderRadius: '50%',
      background: 'var(--dsw-alias-bg-layer-1)',
      boxShadow: '0 1px 2px rgb(0 0 0 / 20%)',
      transition: 'transform 0.15s var(--ds-ease-in-out)',
    }),
    c('&[aria-checked=\'true\']', {
      background: 'var(--dsw-alias-state-business-primary)',
    }, [
      c('&::after', {
        transform: 'translateX(16px)',
      }),
    ]),
    c('&:disabled', {
      opacity: 0.4,
      cursor: 'default',
    }),
  ]),

  c('.dshp-ssh-row-actions', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: 'auto',
  }),

  /* The inline editor: an indented分区 with a hairline top divider. */
  c('.dshp-ssh-editor', {
    margin: '2px 0 4px',
    paddingTop: '12px',
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  }),

  /* The editor's action row: hint left, cancel/save right. */
  c('.dshp-ssh-editor-actions', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
  }, [
    c('.dshp-ssh-hint', {
      marginRight: 'auto',
    }),
  ]),

  c('.dshp-ssh-grid', {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
    gap: '8px 12px',
  }),

  c('.dshp-ssh-field', {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  }),

  c('.dshp-ssh-field-label', {
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  }),

  /*
   * The Input primitive draws the box; the field makes it fill the grid cell.
   * `border-box` is load-bearing: the primitive's `.wrap` is content-box, so a
   * bare `width: 100%` would add its padding/border on top of the track width
   * and bleed ~18px into the neighbouring column (adjacent inputs overlapped).
   */
  c('.dshp-ssh-field-input', {
    boxSizing: 'border-box',
    width: '100%',
  }),

  /* Per-machine status lines. */
  c('.dshp-ssh-status-error', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-error-primary)',
  }),

  c('.dshp-ssh-link', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    fontFamily: 'var(--ds-font-family-code)',
    color: 'var(--dsw-alias-label-tertiary)',
    overflowWrap: 'anywhere',
  }),

  /* The streaming log surface (machine.events lines, or the progress log). */
  c('.dshp-ssh-log-stream', {
    margin: 0,
    maxHeight: '160px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: '11px',
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  /* The one-click install surface (dsh missing on the remote). */
  c('.dshp-ssh-install-box', {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-surface-tinted)',
  }),

  c('.dshp-ssh-install-hint', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  }),

  c('.dshp-ssh-install-note', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  }),

  /* Page-level banners. */
  c('.dshp-ssh-notice', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  }),

  c('.dshp-ssh-error', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-error-primary)',
  }),

  c('.dshp-ssh-hint', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  c('.dshp-ssh-empty', {
    margin: 0,
    padding: '12px',
    border: '1px dashed var(--dsw-alias-border-l3)',
    borderRadius: '8px',
    textAlign: 'center',
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  /* The load-failure block: empty state plus the retry affordance. */
  c('.dshp-ssh-empty-block', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '8px',
  }),

  /* The sync panel (a section-level group under the machine list). */
  c('.dshp-ssh-sync-panel', {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    marginTop: '12px',
    paddingTop: '12px',
    borderTop: '1px solid var(--dsw-alias-border-l2)',
  }),

  c('.dshp-ssh-sync-targets', {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  }),

  c('.dshp-ssh-sync-groups', {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  }),

  c('.dshp-ssh-sync-group', {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  }),

  c('.dshp-ssh-sync-items', {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  }),

  c('.dshp-ssh-sync-item', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  }),

  c('.dshp-ssh-sync-reason', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-tertiary))',
  }),

  /* The root tag inside a skill pill. */
  c('.dshp-ssh-sync-root', {
    marginLeft: '6px',
    fontSize: '10px',
    lineHeight: '14px',
    color: 'var(--dsw-alias-label-tertiary)',
  }),

  c('.dshp-ssh-sync-actions', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  }),

  c('.dshp-ssh-sync-results', {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  }),

  c('.dshp-ssh-sync-summary', {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  }),

  c('.dshp-ssh-sync-result', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  }),

  c('.dshp-ssh-sync-result-name', {
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
  }),

  c('.dshp-ssh-sync-ok', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-success-primary)',
  }),
])
