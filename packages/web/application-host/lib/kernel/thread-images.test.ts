import { expect, it } from 'vitest';
import { parseThreadImages, threadInput } from './thread-images.js';

it('retains explicit image numbers across HTTP admission and separates them from image bytes', () => {
  const images = parseThreadImages([{ mimeType: 'image/png', data: 'YQ==', reference: 1 }, { mimeType: 'image/png', data: 'Yg==', reference: 3 }])!;
  expect(threadInput('Compare [图片1] and [图片3]', [...images, { mimeType: 'image/png', data: 'Yw==' }])).toEqual({
    text: 'Compare [图片1] and [图片3]', imageReferences: [1, 3, 4], attachments: [
      { media_type: 'image/png', data_base64: 'YQ==' }, { media_type: 'image/png', data_base64: 'Yg==' }, { media_type: 'image/png', data_base64: 'Yw==' },
    ],
  });
  expect(threadInput('Text edit')).toEqual({ text: 'Text edit' });
});

it('rejects ambiguous image references before admission', () => {
  const image = { mimeType: 'image/png', data: 'YQ==' };
  for (const reference of [0, -1, 1.5, '1', null]) expect(() => parseThreadImages([{ ...image, reference }])).toThrow();
  expect(() => parseThreadImages([{ ...image, reference: 2 }, { ...image, reference: 2 }])).toThrow();
});
