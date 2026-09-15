// @ts-nocheck
// Pure option resolution from the captured browser driver; executed only against the selected element.
export const resolveReferenceSelectOptions = (el, requested) => {
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag !== "select" || !Array.isArray(requested)) return { kind: "unresolved" };
	const options = [...el.options].filter((option) => !option.disabled);
	if (options.length === 0) return { kind: "unresolved" };
	const significant = (text) =>
		String(text ?? "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]/gu, "");
	const labelOf = (option) => String(option.label ?? option.textContent ?? "").trim();
	const MIN_PREFIX_SIGNIFICANT_CHARS_SO_A_BARE_CODE_LIKE_AL_NEVER_TAKES_ALASKA = 4;
	const resolveVerbatimThenCaselessThenAlphanumericThenShortestLabelPrefix = (wanted) => {
		if (typeof wanted !== "string") return undefined;
		const verbatim = options.find(
			(option) => option.value === wanted || labelOf(option) === wanted.trim(),
		);
		if (verbatim) return verbatim;
		const lower = wanted.trim().toLowerCase();
		const caseless = options.find(
			(option) => option.value.toLowerCase() === lower || labelOf(option).toLowerCase() === lower,
		);
		if (caseless) return caseless;
		const sig = significant(wanted);
		if (sig.length === 0) return undefined;
		const normalized = options.find(
			(option) => significant(option.value) === sig || significant(labelOf(option)) === sig,
		);
		if (normalized) return normalized;
		const byPrefix = options.filter((option) => {
			const label = significant(labelOf(option));
			const shorter = Math.min(label.length, sig.length);
			if (shorter < MIN_PREFIX_SIGNIFICANT_CHARS_SO_A_BARE_CODE_LIKE_AL_NEVER_TAKES_ALASKA)
				return false;
			return label.startsWith(sig) || sig.startsWith(label);
		});
		byPrefix.sort((a, b) => labelOf(a).length - labelOf(b).length);
		return byPrefix[0];
	};
	const values = [];
	let fuzzy = false;
	for (const wanted of requested) {
		const option = resolveVerbatimThenCaselessThenAlphanumericThenShortestLabelPrefix(wanted);
		if (option === undefined) return { kind: "unmatched", optionCount: options.length };
		if (option.value !== wanted) fuzzy = true;
		values.push(option.value);
	}
	return { kind: "matched", values, fuzzy };
};
