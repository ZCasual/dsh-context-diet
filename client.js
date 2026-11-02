/**
 * dsh-context-diet — browser half.
 *
 * Adds one persistent, read-only entry to the composer dock line
 * (`conversation.composer.dock`, list / scope=session), after the official
 * `activity` (order 0) and `usage` (order 1) entries. The entry never replaces
 * an official occupant: it registers under its own id and order 2.
 *
 * Data comes from the Host endpoint `GET /context-diet/stats`, whose `footer`
 * field is already formatted by the Host (`footerLine()`). The Client renders
 * that exact string and never recomputes tokens or sizes itself
 * (see docs/impl-contract.md §4/§5).
 *
 * Bundle format: the client-modules loader evaluates this file through
 * `window.__ModuleLoader__.load({ id, factory })`; `id` must equal the package
 * name. Only platform seed words are requireable here (`react` is the only one
 * this file uses), so `dsh.client.external` is not needed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-diet',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this Client half; never shared with the Host copy. */
    const NS = 'contextDietFooter'
    /** Same-origin read-only Host endpoint; format is defined by impl-contract §4. */
    const STATS_URL = '/context-diet/stats'
    /** 2 s polling in the visible foreground; hidden tabs skip the round. */
    const POLL_MS = 2000

    const en = { label: 'Context diet' }
    const zh = { label: '上下文节食' }

    /** Visual contract of the official stat line: 11–12px, secondary label, tabular digits. */
    const STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '2px',
      padding: '0 2px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11.5px',
      lineHeight: '20px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    }
    /** §5: the `−Nk /req` segment is emphasized with the primary label token. */
    const EMPHASIS = { color: 'var(--dsw-alias-label-primary)' }

    /**
     * Read one footer snapshot from the Host.
     *
     * Never throws and never returns a non-string: an unreachable/unauthorized
     * endpoint, a non-JSON body, or a malformed payload all degrade to
     * `undefined`, which keeps the last rendered text on screen.
     *
     * @returns {Promise<string|undefined>} the Host-formatted footer, or undefined.
     */
    async function feed() {
      try {
        const response = await fetch(STATS_URL, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return undefined
        const payload = await response.json()
        return typeof payload?.footer === 'string' ? payload.footer : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Split the footer at the `−Nk /req` segment so only that part is emphasized.
     * Head and rest concatenate to the exact input string, so the text element's
     * `textContent` stays byte-identical to the Host `footer` field.
     *
     * @param {string} text - Host-formatted footer.
     * @returns {{ head: string, rest: string }}
     */
    function splitFooter(text) {
      const matched = /^(.*? \/req)([\s\S]*)$/.exec(text)
      if (matched === null) return { head: text, rest: '' }
      return { head: matched[1], rest: matched[2] }
    }

    /**
     * The dock entry. Renders nothing while the Host reports no active session
     * (empty footer), otherwise one `data-composer-stat="context-diet"` span.
     *
     * @param {{ feed?: () => Promise<string|undefined> }} props - the entry-level
     *   `inject` supplies `feed`; the module-level reader is the fallback.
     */
    function DietDockEntry(props) {
      const read = typeof props?.feed === 'function' ? props.feed : feed
      const [footer, setFooter] = React.useState('')
      const last = React.useRef('')

      React.useEffect(() => {
        let alive = true

        const refresh = () => {
          // Hidden tab: skip this round instead of spending a request.
          if (document.visibilityState !== 'visible') return
          Promise.resolve(read()).then((next) => {
            if (!alive || typeof next !== 'string') return
            // Unchanged text must not re-render the dock line.
            if (next === last.current) return
            last.current = next
            setFooter(next)
          }).catch(() => {
            /* fail open: keep the previous text */
          })
        }

        refresh()
        const timer = window.setInterval(refresh, POLL_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') refresh()
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
          alive = false
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [read])

      // Contract §5: no active session → render nothing, never a placeholder.
      if (typeof footer !== 'string' || footer === '') return null

      const { head, rest } = splitFooter(footer)
      return h('span', { 'data-composer-dock-entry': 'context-diet' },
        h('span', {
          'data-composer-stat': 'context-diet',
          role: 'status',
          'aria-live': 'polite',
          title: footer,
          style: STYLE,
        }, h('span', { style: EMPHASIS }, head), rest))
    }

    const inject = ['slots', 'locale']

    /**
     * Mount the Client half: dictionaries first, then the dock entry.
     *
     * @param {object} ctx - Client Cordis context (`slots` + `locale` services).
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'context-diet: footer dictionaries')

      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'context-diet',
        order: 2,
        label: () => t('label'),
        locale: NS,
        inject: () => ({ feed }),
      }, DietDockEntry)), 'context-diet: composer dock entry')
    }

    return { inject, apply, NS, POLL_MS, STATS_URL }
  },
})
