import {DomainError,object} from './security.js';
import type {UserBudgetLimits} from '../shared/onboarding.js';
/** Decimal currency input to integer micro-units. No floating-point rounding or currency conversion. */
export function userBudgetInput(raw:unknown):UserBudgetLimits {
    const value=object(raw);
    if(Object.keys(value).some(k=>k!=='CNY'&&k!=='USD')||value.CNY===undefined)throw new DomainError('USER_BUDGET_INVALID',400);
    const amount=(input:unknown)=>{
        if(typeof input==='string'&&['unlimited','不限额'].includes(input.trim()))return null;
        if(typeof input!=='string'||input.length>20||!/^\d{1,7}(\.\d{1,6})?$/.test(input.trim()))throw new DomainError('USER_BUDGET_INVALID',400,'请填写非负金额，最多保留六位小数；不同币种分别设置。');
        const [whole,fraction='']=input.trim().split('.'),micros=Number(whole)*1000000+Number(fraction.padEnd(6,'0'));
        if(!Number.isSafeInteger(micros)||micros>1000000000000)throw new DomainError('USER_BUDGET_INVALID',400);
        return micros;
    };
    return {CNY:amount(value.CNY),USD:amount(value.USD??'0')};
}
