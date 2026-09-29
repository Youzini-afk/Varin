/// <reference types="novnc__novnc" />
// noVNC 1.7 exports RFB from the package root. DefinitelyTyped 1.6 still
// declares the previous package entry; its public RFB API applies unchanged.
declare module '@novnc/novnc' {
  export { default } from '@novnc/novnc/lib/rfb';
}
