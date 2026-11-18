import React from 'react';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { Ic } from '../shared/kit';
import './device-connection-map.css';

export interface ConnectionMapNode {
  id: string;
  label: string;
  detail: string;
  icon: IconName;
  offline?: boolean;
  onOpen(): void;
}

type Line = { id: string; path: string; offline: boolean };

export function DeviceConnectionMap({ clients, resources, service, pending, resourceError }: {
  clients: ConnectionMapNode[];
  resources: ConnectionMapNode[];
  service: ConnectionMapNode;
  pending?: boolean;
  resourceError?: boolean;
}) {
  const { t } = useI18n();
  const graph = React.useRef<HTMLDivElement>(null);
  const hub = React.useRef<HTMLButtonElement>(null);
  const [lines, setLines] = React.useState<Line[]>([]);
  const geometryKey = JSON.stringify([clients, resources].map(nodes => nodes.map(({ id, offline }) => [id, offline])));
  React.useLayoutEffect(() => {
    const panel = graph.current;
    const center = hub.current;
    if (!panel || !center) return;
    const measure = () => {
      const bounds = panel.getBoundingClientRect();
      const base = center.getBoundingClientRect();
      const centerY = base.top + base.height / 2 - bounds.top;
      setLines([...panel.querySelectorAll<HTMLButtonElement>('button[data-map-side]')].map(button => {
        const node = button.getBoundingClientRect();
        const left = button.dataset.mapSide === 'client';
        const centerX = (left ? base.left : base.right) - bounds.left;
        const nodeX = (left ? node.right : node.left) - bounds.left;
        const nodeY = node.top + node.height / 2 - bounds.top;
        const bend = (centerX + nodeX) / 2;
        return { id: button.dataset.mapNode!, offline: button.dataset.offline === 'true',
          path: `M${centerX} ${centerY} C${bend} ${centerY} ${bend} ${nodeY} ${nodeX} ${nodeY}` };
      }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(center);
    panel.querySelectorAll('.device-map-column').forEach(column => observer.observe(column));
    return () => observer.disconnect();
  }, [geometryKey]);

  const column = (nodes: ConnectionMapNode[], side: 'client' | 'resources') => (
    <div className={`device-map-column ${side}`}>
      <h2>{t(`settings.devices.role.${side}`)}</h2>
      {nodes.map(node => <button type="button" key={node.id} data-map-side={side} data-map-node={`${side}:${node.id}`}
        data-offline={node.offline ?? false} className="device-map-node" onClick={node.onOpen} title={`${node.label} · ${node.detail}`}>
        <Ic name={node.icon} size="sm" />
        <span className="sk-grow"><b className="sk-trunc">{node.label}</b><small className="sk-trunc">{node.detail}</small></span>
        {node.offline ? <span className="sk-dot err" aria-hidden /> : null}
      </button>)}
      {!nodes.length && side === 'resources' ? <p role="status">
        {t(pending ? 'common.loading' : resourceError ? 'settings.devices.resourcesUnavailable' : 'settings.devices.noResources')}
      </p> : null}
    </div>
  );

  return <div className="device-map-container">
    <div ref={graph} className="device-map" role="group" aria-label={t('settings.devices.map')}>
      {column(clients, 'client')}
      <button type="button" ref={hub} className="device-map-hub" data-offline={service.offline ?? false} onClick={service.onOpen}>
        <Ic name="server" size="lg" />
        <b>{t('settings.devices.varinService')}</b>
        <span>{service.label}</span>
        <small>{service.detail}</small>
      </button>
      {column(resources, 'resources')}
      <svg className="device-map-lines" aria-hidden="true">
        {lines.map(line => <path key={line.id} data-offline={line.offline} d={line.path} />)}
      </svg>
    </div>
  </div>;
}
