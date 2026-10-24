import { createRequire } from 'node:module';

// xmldom 0.8's declarations import the browser DOM globally. Keep its small XML
// API local so the Node Host retains Node's streams, fetch and WebCrypto types.
export interface XmlNode {
  readonly nodeType: number;
  readonly childNodes: ArrayLike<XmlNode>;
  readonly parentNode: XmlElement | null;
  readonly nextSibling: XmlNode | null;
  textContent: string | null;
  cloneNode(deep: boolean): XmlNode;
}
export interface XmlElement extends XmlNode {
  readonly localName: string;
  readonly ownerDocument: XmlDocument;
  readonly firstChild: XmlNode | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
  getAttribute(name: string): string | null;
  getAttributeNS(namespace: string, name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  setAttributeNS(namespace: string, name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(node: XmlNode): XmlNode;
  insertBefore(node: XmlNode, before: XmlNode | null): XmlNode;
  removeChild(node: XmlNode): XmlNode;
}
export interface XmlDocument extends XmlNode {
  readonly documentElement: XmlElement;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
  createElementNS(namespace: string, name: string): XmlElement;
}
const xml = createRequire(import.meta.url)('@xmldom/xmldom') as {
  DOMParser: new(options: { errorHandler: { warning(message: string): void; error(message: string): void; fatalError(message: string): void } }) => { parseFromString(source: string, mime: string): XmlDocument };
  XMLSerializer: new() => { serializeToString(node: XmlNode): string };
};
export const { DOMParser, XMLSerializer } = xml;
