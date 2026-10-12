module.exports = {
  async activate(context) {
    await context.styles.use('package/panel.css');
    const icon = await context.assets.url('package/panel.svg');
    context.contribute({
      id: 'example.agent-authored-panel.summary',
      entrypoint: 'panel', kind: 'panel', contractVersion: 1, supports: ['web', 'desktop'],
      placement: { slot: 'workbench.secondary.after', order: 20 },
      data: { title: 'Text counter' },
    }, {
      mount(container, mount) {
        const panel = container.ownerDocument.createElement('section');
        panel.className = 'agent-authored-panel';
        const image = container.ownerDocument.createElement('img');
        image.src = icon;
        image.alt = '';
        const label = container.ownerDocument.createElement('p');
        label.textContent = 'Agent-authored text counter · 1.0.0';
        panel.appendChild(image);
        panel.appendChild(label);
        container.appendChild(panel);
        const markAborted = () => { panel.dataset.closed = 'true'; };
        mount.signal.addEventListener('abort', markAborted, { once: true });
        return () => {
          mount.signal.removeEventListener('abort', markAborted);
          panel.remove();
        };
      },
    });
  },
};
