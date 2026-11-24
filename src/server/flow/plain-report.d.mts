export interface HelpTopic {title:string;what:string;impact:string;steps:string[];alternative:string}
export const HELP: Record<string,HelpTopic>;
export function blockerCard(blocker:{code:string}): {helpId:string;title:string;explanation:string;impact:string;actions:{id:string;label:string}[]};
export function plainFlowReport(value:{status:string;completedCount:number;remainingCount:number;blockers:{code:string}[];planVersion:number}): {title:string;planLabel:string;completedLabel:string;remainingLabel:string;blockers:ReturnType<typeof blockerCard>[];accepted:false;nextLabel:string};
export function humanBlockerIntent(value:{flowTerminal:boolean;choice:string}): Record<string,unknown>;
