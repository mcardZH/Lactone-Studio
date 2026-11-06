import { forwardRef, useCallback, useEffect, useRef, type InputHTMLAttributes } from 'react';
import './numeric-input.css';
import {adaptiveNumericStep} from './numeric-step';

export interface NumericInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Opt in only when increment/decrement has a meaningful discrete unit. */
  stepper?: boolean;
  /** Base display increment; smaller decimal values retain their current precision. */
  adaptiveStep?: number;
}

/** Keep native number parsing/validation; a scientific step is not a UI increment. */
const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(function NumericInput(
  { stepper = false, adaptiveStep, className, onKeyDown, ...props }, forwardedRef,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ref = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input;
    if (typeof forwardedRef === 'function') return forwardedRef(input);
    if (forwardedRef) forwardedRef.current = input;
  }, [forwardedRef]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input || stepper) return;
    // React's delegated wheel listener is passive. A local, non-passive listener
    // prevents native stepping without blurring the current editing field.
    const preventStep = (event: WheelEvent) => {
      if (input.ownerDocument.activeElement === input) event.preventDefault();
    };
    input.addEventListener('wheel', preventStep, { passive: false });
    return () => input.removeEventListener('wheel', preventStep);
  }, [stepper]);
  const adaptive=stepper&&adaptiveStep!==undefined;
  const increment=(direction:1|-1)=>{
    const input=inputRef.current;if(!input||props.disabled||props.readOnly||adaptiveStep===undefined)return;
    const next=adaptiveNumericStep(input.value,direction,adaptiveStep,props.min,props.max);if(next===null||Number(next)===Number(input.value)&&input.value!=='')return;
    const win=input.ownerDocument.defaultView as (Window & typeof globalThis)|null;if(!win)return;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value')?.set?.call(input,next);
    input.dispatchEvent(new win.Event('input',{bubbles:true}));
  };
  const control=<input {...props} ref={ref} type="number" data-numeric-stepper={stepper ? 'enabled' : 'disabled'}
    step={adaptive?'any':props.step}
    className={[className, (!stepper||adaptive) && 'numeric-input-direct'].filter(Boolean).join(' ') || undefined}
    onKeyDown={event => {
      onKeyDown?.(event);
      if(adaptive&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&(event.key==='ArrowUp'||event.key==='ArrowDown')){event.preventDefault();increment(event.key==='ArrowUp'?1:-1);return;}
      if (!stepper && !event.nativeEvent.isComposing && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) event.preventDefault();
    }}/>;
  if(!adaptive)return control;
  return <span className="numeric-adaptive">{control}<span className="numeric-adaptive-arrows"><button type="button" tabIndex={-1} aria-label={`增大${props['aria-label']??'数值'}`} disabled={props.disabled||props.readOnly} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();increment(1);}}>▴</button><button type="button" tabIndex={-1} aria-label={`减小${props['aria-label']??'数值'}`} disabled={props.disabled||props.readOnly} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();increment(-1);}}>▾</button></span></span>;
});

export default NumericInput;
