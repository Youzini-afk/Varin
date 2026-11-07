import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { registerImageReadRoute } from './image-read-route.js';

it('uses authenticated Host egress for remote image bytes without forwarding browser credentials',async()=>{
  const app=express(), bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  const fetchImage=vi.fn(async()=>new Response(bytes,{headers:{'content-type':'image/png'}}));
  registerImageReadRoute(app,(req,res,next)=>req.headers.authorization==='Bearer test'?next():void res.sendStatus(401),fetchImage);
  await request(app).post('/api/images/read').send({url:'https://images.test/a.png'}).expect(401);
  expect(fetchImage).not.toHaveBeenCalled();
  const response=await request(app).post('/api/images/read').set('Authorization','Bearer test').set('Cookie','private').send({url:'https://images.test/a.png'}).expect(200);
  expect(response.body).toEqual(bytes);
  expect(fetchImage).toHaveBeenCalledWith('https://images.test/a.png',{signal:expect.any(AbortSignal),headers:{accept:'image/*'}});
  expect(response.headers['cache-control']).toBe('no-store');
});
it('rejects non-network sources and does not publish HTML as an editable image',async()=>{
  const app=express(),fetchImage=vi.fn(async()=>new Response('<html>not an image</html>',{headers:{'content-type':'text/html'}}));
  registerImageReadRoute(app,(_req,_res,next)=>next(),fetchImage);
  await request(app).post('/api/images/read').send({url:'file:///private.png'}).expect(400);expect(fetchImage).not.toHaveBeenCalled();
  await request(app).post('/api/images/read').send({url:'https://images.test/page'}).expect(502,{code:'image-source-unavailable'});
});
