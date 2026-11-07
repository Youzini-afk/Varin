import { expect, it } from 'vitest';
import { commitMarks, undoMarks, redoMarks, moveMark, resizeMark, hitMark, markOutline, markOpacity, prepareAnnotatedImages, type ImageAnnotationDocument, type ImageMark } from './annotations';
const source={data:'original-pixels',mimeType:'image/png'};
const original:ImageAnnotationDocument={source,width:1000,height:800,marks:[],past:[],future:[]};
const arrow:ImageMark={id:'arrow',kind:'arrow',color:'#e34d59',width:3,fontSize:24,from:{x:10,y:10},to:{x:80,y:50}};
it('undoes whole operations including clear, redoes them, and forks editing without copying original pixels',()=>{
  const drawn=commitMarks(original,[arrow]),moved=commitMarks(drawn,[moveMark(arrow,20,30)]),cleared=commitMarks(moved,[]);
  expect(undoMarks(cleared).marks).toBe(moved.marks);
  expect(undoMarks(undoMarks(moved)).marks).toBe(original.marks);
  expect(redoMarks(undoMarks(moved)).marks).toBe(moved.marks);
  const changed=commitMarks(undoMarks(moved),[{...arrow,color:'#477bc5'}]);
  expect(changed.future).toEqual([]);expect(redoMarks(changed)).toBe(changed);
  expect(changed.source).toBe(source);expect(original.marks).toEqual([]);
});
it('selects the topmost actual stroke and resizes while retaining other objects',()=>{
  expect(hitMark([arrow],{x:45,y:30},3)?.id).toBe('arrow');
  expect(hitMark([arrow],{x:45,y:70},3)).toBeUndefined();
  const resized=resizeMark(arrow,{x:200,y:150});
  expect(resized.from).toEqual(arrow.from);expect(resized.to).toEqual({x:200,y:150});
  expect(arrow.to).toEqual({x:80,y:50});
});
it('retains editable stroke styles through undo and redo while covers remain opaque',()=>{
  const plain={...arrow,outline:'none' as const,opacity:1};
  const drawn=commitMarks(original,[plain]);
  const styled=commitMarks(drawn,[{...plain,outline:'dark',opacity:.5,width:6}]);
  expect(markOutline(plain)).toBeUndefined();
  expect(markOutline(styled.marks[0]!)).toBe('#202124');
  expect(markOpacity(styled.marks[0]!)).toBe(.5);
  expect(undoMarks(styled).marks).toBe(drawn.marks);
  expect(redoMarks(undoMarks(styled)).marks).toBe(styled.marks);
  expect(markOpacity({...plain,kind:'cover',opacity:.1})).toBe(1);
  expect(markOutline({...plain,kind:'cover',outline:'light'})).toBeUndefined();
});
it('only prepares the visible image and its number for transmission, without source or edit metadata',async()=>{
  const image={data:'visible',mimeType:'image/png',reference:7,annotation:{...original,source:{data:'visible',mimeType:'image/png'}}};
  expect(await prepareAnnotatedImages([image])).toEqual([{data:'visible',mimeType:'image/png',reference:7}]);
  expect(image.annotation.source).toBeDefined();
});
