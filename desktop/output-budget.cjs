'use strict';
const DEFAULT_OUTPUT_BUDGET_BYTES = Number.POSITIVE_INFINITY;
const MAX_RETAINED_LOG_CHARS = 1024 ** 2;
function outputBudget(resources, fallback = DEFAULT_OUTPUT_BUDGET_BYTES) {
  const value = resources?.outputBudgetBytes ?? resources?.configured?.outputBudgetBytes ?? fallback;
  if (value === Number.POSITIVE_INFINITY && resources?.outputBudgetBytes === undefined && resources?.configured?.outputBudgetBytes === undefined) return value;
  if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid cumulative output budget');
  return value;
}
// Preserve the setup/header and final diagnostics without retaining every
// progress line. The cumulative byte counter is maintained independently.
function boundedLog(previous, text) {
  const value = previous + text;
  if (value.length <= MAX_RETAINED_LOG_CHARS) return value;
  const half = MAX_RETAINED_LOG_CHARS / 2;
  return value.slice(0, half) + value.slice(-half);
}
function scientificLog() {
  let tail='', selected='';
  const significant=/xtb version|GEOMETRY OPTIMIZATION|CONVERGED AFTER|convergence criteria|RF solver|Fast Inertial|TOTAL ENERGY|FAILED TO CONVERGE|ABNORMAL|ERROR|Solvation|Solvent|Parameter file|Dielectric|Reference state|Free energy shift|Temperature|Density|Interaction kernel|Born|H-bond|Ion screening|Surface tension|Grid points/i;
  const accept=line=>{if(significant.test(line)){selected+=line+'\n';}};
  return {
    push(text){tail+=text;let end;while((end=tail.indexOf('\n'))>=0){accept(tail.slice(0,end));tail=tail.slice(end+1);}},
    finish(){if(tail){accept(tail);tail='';}return selected;},
  };
}
module.exports = {DEFAULT_OUTPUT_BUDGET_BYTES, MAX_RETAINED_LOG_CHARS, outputBudget, boundedLog, scientificLog};
