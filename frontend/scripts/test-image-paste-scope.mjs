import assert from 'node:assert/strict';
import {maySelectImageDrop,mayPasteImageDrop,shouldReleaseImageDrop} from '../src/utils/imagePasteScope.js';
let checks=0;
function equal(actual,expected,message){assert.equal(actual,expected,message);checks++;}
equal(maySelectImageDrop({ownTarget:true,pasteFirst:true}),true,'Clicking the explicit paste area selects it');
equal(maySelectImageDrop({insideScope:true,pasteFirst:true}),false,'Paste-first mode requires selecting its own area');
equal(maySelectImageDrop({insideScope:true,pasteFirst:false}),true,'Legacy form blank-area selection remains available');
equal(maySelectImageDrop({}),false,'Clicks outside the form do not select the drop area');
for(const field of ['foreignOwner','imageUpload','editable','foreignDialog']){
  equal(maySelectImageDrop({ownTarget:true,insideScope:true,[field]:true}),false,'Cannot select by clicking '+field);
}
const ready={selected:true,visible:true};
equal(mayPasteImageDrop(ready),true,'Selected visible area accepts clipboard images');
equal(mayPasteImageDrop({...ready,otherImageActive:false}),true,'Reserved paste-area ownership allows the area to consume paste');
for(const field of ['disabled','uploading','foreignOwner','imageUpload','editable','foreignDialog','otherImageActive']){
  equal(mayPasteImageDrop({...ready,[field]:true}),false,'Paste must yield to '+field);
}
equal(mayPasteImageDrop({...ready,selected:false}),false,'An unselected paste-first area never consumes paste');
equal(mayPasteImageDrop({...ready,visible:false}),false,'Hidden dialogs never consume paste');
equal(mayPasteImageDrop({...ready,foreignOwner:true,imageUpload:false}),false,'Payment-proof container without an ImageUpload child owns its paste event');
equal(mayPasteImageDrop({...ready,foreignDialog:true,editable:true}),false,'Management dialog text inputs are never intercepted');
equal(mayPasteImageDrop({selected:false,visible:true,otherImageActive:true}),false,'Hovering a specific image hands paste ownership to that image');
equal(mayPasteImageDrop({visible:true,hoveredOwn:true}),true,'Verified foreground hover accepts an image without a click');
equal(mayPasteImageDrop({visible:true,hoveredOwn:true,editable:true}),true,'Image hover ownership takes priority over the old keyboard input focus');
equal(mayPasteImageDrop({visible:true,hoveredOwn:true,otherImageActive:true}),true,'Verified hover can replace a stale image token set by old keyboard focus');
equal(mayPasteImageDrop({visible:true,selected:false,hoveredOwn:false}),false,'Leaving the hover area releases all prior selection');
equal(mayPasteImageDrop({visible:true,selected:false,hoveredOwn:false,editable:true}),false,'After pointer leave the old input focus cannot revive the drop area');
for(const field of ['foreignOwner','foreignDialog','imageUpload','disabled','uploading']){
  equal(mayPasteImageDrop({visible:true,hoveredOwn:true,[field]:true}),false,'Hovered scope still yields to '+field+' under the pointer');
}
equal(mayPasteImageDrop({visible:false,hoveredOwn:true}),false,'Hidden or background upload areas never accept hover paste');
equal(shouldReleaseImageDrop({isCurrentOwner:false,hasPasteOwner:true}),false,'A sibling tile cannot clear the owner claimed by another paste scope');
equal(shouldReleaseImageDrop({isCurrentOwner:false,imageUpload:true}),false,'A detail tile cannot clear another ImageUpload owner');
equal(shouldReleaseImageDrop({isCurrentOwner:true,hasPasteOwner:true}),true,'The former owner may release its own token when another scope is targeted');
equal(shouldReleaseImageDrop({isCurrentOwner:true,imageUpload:true}),true,'The former drop owner may release itself when a specific image is targeted');
equal(shouldReleaseImageDrop({isCurrentOwner:false,hasPasteOwner:false,imageUpload:false}),true,'Clicking ordinary form space clears an old globally active image');
equal(maySelectImageDrop({insideScope:true,pasteFirst:true}),false,'A detail tile uses explicit ownership and cannot activate from arbitrary form space');
// Pointer capture callbacks run for every visible tile, in either registration order.
let owner='style-A';
if(shouldReleaseImageDrop({isCurrentOwner:owner==='style-B',hasPasteOwner:true}))owner=null;
equal(owner,'style-A','A later sibling callback leaves the newly selected style owner intact');
owner='style-B';
if(shouldReleaseImageDrop({isCurrentOwner:owner==='style-B',hasPasteOwner:true}))owner=null;
owner='style-A';
equal(owner,'style-A','An earlier previous-owner callback can release before the target claims ownership');
console.log('PASS '+checks+' image-paste ownership assertions');
