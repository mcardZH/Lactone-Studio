/** Gaussian's final archive repeats input and numeric data, wrapped at fixed
 * columns. A physical line can therefore begin with #P without being a route
 * echo. Keep this record out of the human-readable output grammar; no archive
 * contents are needed to index already printed scientific observations. */
export class GaussianOutputArchive {
  private active = false;

  consume(text: string): boolean {
    // Recover at a proven output boundary even if an archive was truncated.
    if (this.active && /^\s*(?:Entering Gaussian System\b|Link1:.*Proceeding to internal job step|--Link1--\s*$|Normal termination of Gaussian\b|Error termination\b)/.test(text)) {
      this.active = false;
      return false;
    }
    if (/^\s*1\\1\\/.test(text)) this.active = true;
    if (!this.active) return false;
    if (/\\+@\s*$/.test(text)) this.active = false;
    return true;
  }
}

/** A bounded look-ahead for Gaussian's dashed title echo immediately before
 * Symbolic Z-matrix / Charge. Until that boundary proves a title, replay the
 * buffered lines unchanged: early native failures must never be swallowed.
 * Delimiters may also close the preceding route/IOp echo, so a rejected pair's
 * final delimiter remains the next possible opening delimiter. */
export class GaussianOutputTitle<T extends {text:string}> {
  private pending:T[]=[];
  private closing=-1;
  private characters=0;
  private eligible=true;
  private separator(text:string):boolean{return /^\s*-{3,}\s*$/.test(text);}
  private track(lines:T[]):void{
    for(const line of lines){
      if(/^\s*(?:Entering Gaussian System\b|Initial command\s*:|Gaussian\s+\d{2,4}\s*:|Link1:.*Proceeding to internal job step|--Link1--\s*$)/.test(line.text))this.eligible=true;
      else if(/^\s*(?:Symbolic Z-matrix\s*:|Charge\s*=|(?:Input|Standard|Z-Matrix) orientation\s*:)/i.test(line.text))this.eligible=false;
    }
  }
  private clear():void{this.pending=[];this.closing=-1;this.characters=0;}
  consume(line:T):{lines:T[];title?:T[]} {
    if(this.pending.length){
      if(this.closing>=0){
        if(/^\s*(?:Symbolic Z-matrix\s*:|Charge\s*=\s*[+-]?\d+\s+Multiplicity\s*=\s*\d+)/i.test(line.text)){
          const title=this.pending.slice(1,this.closing);this.clear();this.eligible=false;return{lines:[line],title};
        }
        if(!line.text.trim()&&this.pending.length-this.closing<8){this.pending.push(line);return{lines:[]};}
        const before=this.pending.slice(0,this.closing),last=this.pending.slice(this.closing);
        this.clear();this.track(before);
        if(this.eligible){
          this.pending=last;this.characters=last.reduce((sum,row)=>sum+row.text.length,0);
          const next=this.consume(line);return{lines:[...before,...next.lines],...(next.title?{title:next.title}:{})};
        }
        this.track([...last,line]);return{lines:[...before,...last,line]};
      }
      this.pending.push(line);this.characters+=line.text.length;
      if(this.separator(line.text))this.closing=this.pending.length-1;
      if(this.pending.length>128||this.characters>8192){const lines=this.finish();return{lines};}
      return{lines:[]};
    }
    this.track([line]);
    if(this.eligible&&this.separator(line.text)){this.pending=[line];this.characters=line.text.length;return{lines:[]};}
    return{lines:[line]};
  }
  finish():T[]{const lines=this.pending;this.clear();this.track(lines);return lines;}
}
