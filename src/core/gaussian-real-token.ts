/** Gaussian's ModRedundant real fields require a real lexical token even for integer values. */
export function gaussianRealToken(value: number | string): string {
	const token = String(value).trim();
	if (
		!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(token) ||
		!Number.isFinite(Number(token.replace(/[dD]/, "e")))
	)
		return token;
	const exponent = token.search(/[eEdD]/);
	const mantissa = exponent < 0 ? token : token.slice(0, exponent);
	return mantissa.includes(".")
		? token
		: mantissa + ".0" + (exponent < 0 ? "" : token.slice(exponent));
}
