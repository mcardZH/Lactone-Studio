import { OperationType, type Action } from "ketcher-core";
type NativeOperation = Action["operations"][number];

/** Source ownership travels inside the actual Ketcher Action, including undo/redo.
 * This is an operation, not a parallel history or a KET-to-source cache. */
export class TwoDSourceOperation<T> {
	_inverted?: TwoDSourceOperation<T>;
	readonly type = OperationType.CANVAS_LOAD;
	readonly priority = 1000;
	constructor(
		private read: () => T,
		private write: (value: T) => void,
		private value: T
	) {}
	perform(): NativeOperation {
		const previous = this.read();
		this.write(this.value);
		if (!this._inverted) {
			this._inverted = new TwoDSourceOperation(this.read, this.write, previous);
			this._inverted._inverted = this;
		}
		return this._inverted as unknown as NativeOperation;
	}
	isDummy() {
		return false;
	}
}
