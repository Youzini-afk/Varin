export const imageAnnotationsEn = {
  'imageEditor.annotate':'Annotate', 'imageEditor.done':'Done', 'imageEditor.reply':'Use in reply', 'imageEditor.tools':'Image annotation tools',
  'imageEditor.tool.select':'Select and move', 'imageEditor.tool.pen':'Pen', 'imageEditor.tool.arrow':'Arrow', 'imageEditor.tool.rectangle':'Rectangle', 'imageEditor.tool.ellipse':'Ellipse', 'imageEditor.tool.text':'Text', 'imageEditor.tool.number':'Number', 'imageEditor.tool.cover':'Cover',
  'imageEditor.undo':'Undo', 'imageEditor.redo':'Redo', 'imageEditor.delete':'Delete selected', 'imageEditor.clear':'Clear annotations', 'imageEditor.color':'Color', 'imageEditor.weight':'Stroke',
  'imageEditor.color.0':'Red', 'imageEditor.color.1':'Amber', 'imageEditor.color.2':'Green', 'imageEditor.color.3':'Blue', 'imageEditor.color.4':'Purple', 'imageEditor.color.5':'Charcoal', 'imageEditor.color.6':'White',
  'imageEditor.panHint':'Space + drag to pan · pinch to zoom', 'imageEditor.coverHint':'Covered pixels are removed from the sent image.',
  'imageEditor.text':'Annotation text', 'imageEditor.saving':'Preparing image…', 'imageEditor.failed':'Could not prepare this image. Your annotations are retained; try again.',
  'imageEditor.readFailed':'The original image could not be read for editing. The source may not allow access.', 'imageEditor.edited':'Annotated', 'imageEditor.original':'Show original',
  'imageEditor.style':'Style', 'imageEditor.styleSelected':'Selected annotation', 'imageEditor.styleNext':'New annotations', 'imageEditor.opacity':'Opacity',
  'imageEditor.outline':'Outline', 'imageEditor.outline.none':'None', 'imageEditor.outline.light':'Light', 'imageEditor.outline.dark':'Dark', 'imageEditor.outline.auto':'Auto',
} as const;
export const imageAnnotationsZhCN = {
  'imageEditor.annotate':'标注', 'imageEditor.done':'完成', 'imageEditor.reply':'用于回复', 'imageEditor.tools':'图片标注工具',
  'imageEditor.tool.select':'选择与移动', 'imageEditor.tool.pen':'画笔', 'imageEditor.tool.arrow':'箭头', 'imageEditor.tool.rectangle':'矩形', 'imageEditor.tool.ellipse':'椭圆', 'imageEditor.tool.text':'文字', 'imageEditor.tool.number':'编号', 'imageEditor.tool.cover':'遮挡',
  'imageEditor.undo':'撤销', 'imageEditor.redo':'重做', 'imageEditor.delete':'删除选中标注', 'imageEditor.clear':'清除标注', 'imageEditor.color':'颜色', 'imageEditor.weight':'线宽',
  'imageEditor.color.0':'红色', 'imageEditor.color.1':'琥珀色', 'imageEditor.color.2':'绿色', 'imageEditor.color.3':'蓝色', 'imageEditor.color.4':'紫色', 'imageEditor.color.5':'深灰色', 'imageEditor.color.6':'白色',
  'imageEditor.panHint':'空格＋拖动平移 · 双指缩放', 'imageEditor.coverHint':'发送的图片会实际覆盖被遮挡的像素。',
  'imageEditor.text':'标注文字', 'imageEditor.saving':'正在准备图片…', 'imageEditor.failed':'图片准备失败，标注已保留，可以重试。',
  'imageEditor.readFailed':'无法读取原图进行编辑，图片来源可能不允许访问。', 'imageEditor.edited':'已标注', 'imageEditor.original':'查看原图',
  'imageEditor.style':'样式', 'imageEditor.styleSelected':'所选标注', 'imageEditor.styleNext':'新标注', 'imageEditor.opacity':'不透明度',
  'imageEditor.outline':'描边', 'imageEditor.outline.none':'无', 'imageEditor.outline.light':'浅色', 'imageEditor.outline.dark':'深色', 'imageEditor.outline.auto':'自动',
} satisfies Record<keyof typeof imageAnnotationsEn,string>;
