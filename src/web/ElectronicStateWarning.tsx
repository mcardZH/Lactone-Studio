/** One nearby, optional explanation. Opening it never confirms or changes q/M. */
export default function ElectronicStateWarning({message}:{message?:string|null}) {
  return message?<details className="electronic-state-warning" data-testid="electronic-state-warning"><summary aria-label="电子态不匹配说明" title="电子态不匹配">!</summary><span role="note">{message}</span></details>:null;
}
