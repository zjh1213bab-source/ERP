import {ref} from 'vue';
// 所有图片上传位共用焦点，粘贴/拖放一次只上传到当前选中的位置。
export const activeImageUpload=ref(null);
let sequence=0;
export const nextImageUploadId=()=>`image-upload-${++sequence}`;
