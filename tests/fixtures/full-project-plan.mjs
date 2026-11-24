// Offline model input/output contract data. This is never imported by product code or a Live audit.
export function fixtureProjectPlan(requirements){return {
 goal:'制作可以保存内容的本地记录工具',requirements,
 acceptance:requirements.map((r,i)=>({id:'A'+i,check:'保存内容并重新打开，确认内容仍在。',requirementIds:[r.id]})),
 architecture:{summary:'本地界面与本地数据存储',runtime:'Node',components:['界面','存储']},
 dataModel:{entities:['记录'],persistence:'本地文件'},interfaces:{userFlows:['添加、查看和修改记录'],boundaries:['不公开数据']},
 tasks:[{id:'T1',title:'实现保存与回看',dependsOn:[],requirementIds:requirements.map(r=>r.id),check:'真实保存后重新打开'}],
 delivery:{type:'local-app',howToUse:'在本机打开应用',standalone:true,needsInternet:false,ongoingFees:[]},
 resources:{accounts:[],hardware:['现有电脑'],network:[],ongoingCosts:[]},risks:['需验证异常退出时数据保护'],
 milestones:['完成核心操作','验证与交付'],assumptions:['默认仅供本机个人使用'],unknowns:[],outOfScope:['公开部署'],
 research:{status:'UNAVAILABLE',sourceRefs:[]},reuse:{mode:'IMPLEMENT_ORIGINAL',selected:[]}
};}
