import {toolError} from './types';

type Schema=Record<string,unknown>;
const isObject=(value:unknown):value is Schema=>typeof value==='object'&&value!==null&&!Array.isArray(value);
type ArgumentIssue = { path:string; message:string; expected?:unknown };
const issue=(path:string,message:string,expected?:unknown):ArgumentIssue=>({path,message,expected});

/** Enforce the same published argument contract for external tools, the assistant and batch members. */
export function checkToolArguments(schema:Schema,value:unknown,root='arguments'){
  function problem(rule:Schema,v:unknown,path:string):ArgumentIssue|undefined{
    if(Array.isArray(rule.oneOf)||Array.isArray(rule.anyOf)){
      const variants=(rule.oneOf??rule.anyOf) as Schema[];
      const issues=variants.map(variant=>problem(variant,v,path));
      const matches=issues.filter(issue=>issue===undefined).length;
      if(!matches&&rule.oneOf&&isObject(v)){
        // One required literal field can identify which branch supplies the
        // useful error even though the whole object failed every branch.
        for(const [key,value] of Object.entries(v)){
          const discriminants=variants.map(variant=>{
            const field=isObject(variant.properties)?variant.properties[key]:undefined;
            if(!Array.isArray(variant.required)||!variant.required.includes(key)||!isObject(field))return undefined;
            if(Object.hasOwn(field,'const'))return [field.const];
            if(Array.isArray(field.enum)&&field.enum.length===1)return field.enum;
            return undefined;
          });
          if(discriminants.some(values=>values===undefined))continue;
          const selected=discriminants.flatMap((values,index)=>values?.includes(value)?[index]:[]);
          if(selected.length===1)return issues[selected[0]];
        }
      }
      if(!matches||(rule.oneOf&&matches!==1)){
        const forms=variants.slice(0,6).map((variant,index)=>({
          required:variant.required,
          type:variant.type,
          fields:isObject(variant.properties)?Object.keys(variant.properties):undefined,
          issue:issues[index],
        }));
        return issue(path,'不符合支持的参数形式。',{forms});
      }
    }
    if(Array.isArray(rule.enum)&&!rule.enum.includes(v)||'const' in rule&&v!==rule.const)
      return issue(path,'不是支持的取值。',{values:rule.enum??[rule.const]});
    const type=v===null?'null':Array.isArray(v)?'array':typeof v;
    const types=Array.isArray(rule.type)?rule.type:rule.type?[rule.type]:[];
    if(types.length&&!types.includes(type)&&!(type==='number'&&Number.isSafeInteger(v)&&types.includes('integer')))
      return issue(path,'类型不符。',{types});
    if(typeof v==='number'){
      if(!Number.isFinite(v)||typeof rule.minimum==='number'&&v<rule.minimum||typeof rule.maximum==='number'&&v>rule.maximum||
        typeof rule.exclusiveMinimum==='number'&&v<=rule.exclusiveMinimum)
        return issue(path,'超出数值范围。',{minimum:rule.minimum,maximum:rule.maximum,exclusiveMinimum:rule.exclusiveMinimum});
    }
    if(typeof v==='string'&&(typeof rule.minLength==='number'&&v.length<rule.minLength||typeof rule.pattern==='string'&&!new RegExp(rule.pattern).test(v)))
      return issue(path,'文本格式不符。',{minLength:rule.minLength,pattern:rule.pattern});
    if(Array.isArray(v)){
      if(typeof rule.minItems==='number'&&v.length<rule.minItems||typeof rule.maxItems==='number'&&v.length>rule.maxItems)
        return issue(path,'成员数不符。',{minItems:rule.minItems,maxItems:rule.maxItems});
      if(rule.uniqueItems&&new Set(v.map(item=>JSON.stringify(item))).size!==v.length)return issue(path,'含有重复成员。');
      if(isObject(rule.items))for(let i=0;i<v.length;i++){const issue=problem(rule.items,v[i],path+'['+i+']');if(issue)return issue;}
    }else if(isObject(v)){
      for(const key of rule.required as string[]??[])if(!Object.hasOwn(v,key))return issue(path+'.'+key,'缺失。');
      const fields=isObject(rule.properties)?rule.properties:{};
      for(const [key,item] of Object.entries(v)){
        const field=Object.hasOwn(fields,key)?fields[key]:rule.additionalProperties;
        if(field===false)return issue(path+'.'+key,'不是此操作支持的参数。',{properties:Object.keys(fields)});
        if(isObject(field)){const issue=problem(field,item,path+'.'+key);if(issue)return issue;}
      }
    }
  }
  const problemFound=problem(schema,value,root);
  if(problemFound){const {path,message,expected}=problemFound;throw toolError('invalid_arguments',path+' '+message,{path,expected});}
}
