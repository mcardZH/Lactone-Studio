import type {PersonalFragmentTemplate} from '../../modeling/personal-fragments';
import {FragmentPreview} from './FragmentLibrary';

/** The existing SVG projection observes the saved XYZ/graph directly. Cards
 * create no canvas, WebGL context, model transaction or inferred geometry. */
export default function PersonalFragmentCardPreview({fragment}:{fragment:PersonalFragmentTemplate}){
  return <div className="personal-fragment-card-preview" data-testid="personal-fragment-card-preview"><FragmentPreview template={{id:fragment.id,label:fragment.name,atoms:fragment.atoms,bonds:fragment.bonds,anchor:fragment.activeIndex,connectionAnchor:fragment.activeIndex}}/></div>;
}
