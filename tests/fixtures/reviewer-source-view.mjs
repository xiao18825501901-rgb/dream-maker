// Explicit synthetic field fixture shared by view assertions and the offline Chrome check.
import {FrontendReviewAdapter} from '../../dist/web/frontend-review-api.js';import {shell} from '../../dist/web/views.js';import {defaults} from '../../dist/server/config.js';
export async function reviewerSourceView(source){
 const adapter=new FrontendReviewAdapter('dream-maker');await adapter.init();const snapshot=await adapter.request('/projects/sample-review');snapshot.runs[0].review={source,verdict:'BLOCKED',findings:[],treeHash:'SYNTHETIC_NOT_MODEL'};
 const view={mode:'public-demo',presentation:'frontend-review',product:'dream-maker',screen:'project',snapshot,settings:{config:structuredClone(defaults),keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED'},tab:'work',projects:[snapshot.project],busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:200,clash:null,hasDraft:()=>false,draft:()=>''};return shell(view);
}
