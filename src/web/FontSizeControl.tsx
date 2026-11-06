export type FontSize = 'standard' | 'large' | 'larger';

export default function FontSizeControl({ value, onChange }: { value: FontSize; onChange: (value: FontSize) => void }) {
  return <label className="font-size-control">界面字号<select aria-label="界面字号" value={value} onChange={event => onChange(event.target.value as FontSize)}><option value="standard">标准</option><option value="large">大</option><option value="larger">更大</option></select></label>;
}
