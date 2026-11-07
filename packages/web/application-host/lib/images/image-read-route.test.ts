import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { registerImageReadRoute } from './image-read-route.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createEgressRuntime } from '../harness/egress.js';

it('reads a local image through authenticated Host egress without forwarding browser credentials',async()=>{
  const app=express(), bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  const received: Array<import('node:http').IncomingHttpHeaders> = [];
  const server = createServer((req,res)=>{received.push(req.headers);res.setHeader('Content-Type','image/png');res.end(bytes);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const egress=createEgressRuntime({env:{}}),fetchImage=vi.fn(egress.fetch);
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/a.png`;
  try {
    registerImageReadRoute(app,(req,res,next)=>req.headers.authorization==='Bearer test'?next():void res.sendStatus(401),fetchImage);
    await request(app).post('/api/images/read').send({url}).expect(401);
    expect(fetchImage).not.toHaveBeenCalled();
    const response=await request(app).post('/api/images/read').set('Authorization','Bearer test').set('Cookie','private').send({url}).expect(200);
    expect(response.body).toEqual(bytes);
    expect(fetchImage).toHaveBeenCalledWith(url,{signal:expect.any(AbortSignal),headers:{accept:'image/*'}});
    expect(received).toHaveLength(1);expect(received[0]).not.toHaveProperty('authorization');expect(received[0]).not.toHaveProperty('cookie');
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {await egress.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('rejects non-network sources and does not publish HTML as an editable image',async()=>{
  const app=express(),fetchImage=vi.fn(async()=>new Response('<html>not an image</html>',{headers:{'content-type':'text/html'}}));
  registerImageReadRoute(app,(_req,_res,next)=>next(),fetchImage);
  await request(app).post('/api/images/read').send({url:'file:///private.png'}).expect(400);expect(fetchImage).not.toHaveBeenCalled();
  await request(app).post('/api/images/read').send({url:'https://images.test/page'}).expect(502,{code:'image-source-unavailable'});
});
