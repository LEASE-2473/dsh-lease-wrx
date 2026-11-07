/**
 * dsh-wrx-memory — Client 半侧。
 * 在 DSH 设置页注册一级分区「温柔乡记忆」，内嵌 /plugins/dsh-wrx-memory/ui。
 *
 * 使用DSH设置页的原生插槽注册：
 *   slots.inject('settings.section', () => slots.register(
 *     { name: 'settings.section', id, order, label }, () => h(Panel),
 *   ))
 */
window.__ModuleLoader__.load({
  id: 'dsh-wrx-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const UI = '/plugins/dsh-wrx-memory/ui'

    const Panel = () =>
      h('iframe', {
        src: UI,
        title: 'LEASE WRX',
        style: {
          width: '100%',
          height: 'calc(100vh - 150px)',
          minHeight: '520px',
          border: '0',
          display: 'block',
          background: 'transparent',
        },
      })

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-wrx-memory', order: 35, label: 'LEASE WRX' },
          () => h(Panel),
        ))
      },
    }
  },
})
