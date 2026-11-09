/** 新款粘贴区只认自己的选择状态，不能消费输入框、其他上传位或子弹窗的粘贴。 */
export function maySelectImageDrop({ownTarget=false,insideScope=false,pasteFirst=false,foreignOwner=false,imageUpload=false,editable=false,foreignDialog=false}={}) {
  if(foreignOwner||imageUpload||editable||foreignDialog)return false;
  return ownTarget||!pasteFirst&&insideScope;
}
export function mayPasteImageDrop({selected=false,hoveredOwn=false,visible=false,disabled=false,uploading=false,foreignOwner=false,imageUpload=false,editable=false,foreignDialog=false,otherImageActive=false}={}) {
  // hoveredOwn 必须先通过鼠标坐标的最上层命中校验；键盘原焦点不抢占当前鼠标归属。
  return (selected||hoveredOwn)&&visible&&!disabled&&!uploading&&!foreignOwner&&!imageUpload&&!foreignDialog&&(!editable||hoveredOwn)&&(!otherImageActive||hoveredOwn);
}
/** 多个款式/细节上传区同时挂载时，不得清空另一个区域刚认领的 token。 */
export function shouldReleaseImageDrop({isCurrentOwner=false,hasPasteOwner=false,imageUpload=false}={}) {
  return isCurrentOwner||!hasPasteOwner&&!imageUpload;
}
