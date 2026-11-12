import type {Response as HttpResponse} from 'express';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
/** Only file-content headers cross a resource-owner boundary, never cookies or redirects. */
export async function sendResourceAsset(result:Response,response:HttpResponse):Promise<void>{
  response.status(result.status);
  for(const name of ['content-type','content-length','content-range','accept-ranges','etag','x-varin-document-revision','x-varin-render-engine']) {
    const value=result.headers.get(name);if(value!==null)response.setHeader(name,value);
  }
  response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Content-Type-Options','nosniff');
  if(result.body)await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream),response);
  else response.end();
}
