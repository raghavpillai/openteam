// @ts-nocheck
// Option resolution from the reference browser driver; executed only against the selected element.
export const resolveReferenceSelectOptions = (el, requested) => {
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag !== "select" || !Array.isArray(requested)) return { kind: "unresolved" };
	const options = [...el.options].filter((option) => !option.matches(":disabled"));

	const significant = (text) =>
		String(text ?? "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]/gu, "");
	const labelOf = (option) => String(option.label ?? option.textContent ?? "").trim();
	const MIN_PREFIX_SIGNIFICANT_CHARS_SO_A_BARE_CODE_LIKE_AL_NEVER_TAKES_ALASKA = 4;
	const resolveVerbatimThenCaselessThenAlphanumericThenShortestLabelPrefix = (wanted) => {
		if (typeof wanted !== "string") return undefined;
		// Values are identifiers; an earlier display label must not shadow one.
		const verbatim = options.find((option) => option.value === wanted) ??
			options.find((option) => labelOf(option) === wanted.trim());
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

// A write-only value goes into a native <select> without naming it: exact value or label, then
// number, label prefix, two-letter country code, or an MM/YY expiry's month or year list.
// Adaptation: an option inside a disabled optgroup counts as disabled, as in the resolver above.
export const RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN = (el, value) => {
  const options = [...el.options];
  const labelOf = (option) => String(option.label || option.text || "").trim();
  const significant = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const wanted = value.trim();
  const expiryOf = (text) => {
    const parts = /^\s*(\d{1,2})\s*[/\-.\s]\s*(\d{2}|\d{4})\s*$/.exec(text);
    if (parts === null || Number(parts[1]) < 1 || Number(parts[1]) > 12) return undefined;
    const year = Number(parts[2]);
    return { month: Number(parts[1]), year: parts[2].length === 2 ? 2000 + year : year };
  };
  const expiry = expiryOf(wanted);
  const tiers = [
    (text) => text === value || text === wanted,
    (text) => text.toLowerCase() === wanted.toLowerCase(),
    ...(expiry === undefined
      ? [(text) => significant(text).length > 0 && significant(text) === significant(wanted)]
      : []),
  ];
  const theOneEnabled = (hits, how) => {
    const enabled = hits.filter((option) => !option.matches(":disabled"));
    return enabled.length === 1
      ? { kind: "matched", value: enabled[0].value, how }
      : { kind: "unmatched" };
  };
  for (const same of tiers) {
    const hits = options.filter((option) => same(option.value) || same(labelOf(option)));
    if (hits.length > 0) return theOneEnabled(hits, same === tiers[0] ? "exact" : "label");
  }
  if (/^\d{1,4}$/.test(wanted)) {
    const sameNumber = (candidate) => {
      if (!/^\d{1,4}$/.test(candidate)) return false;
      if (Number(candidate) === Number(wanted)) return true;
      const [short, long] =
        candidate.length < wanted.length ? [candidate, wanted] : [wanted, candidate];
      return (
        short.length === 2 && long.length === 4 && long.startsWith("20") && long.endsWith(short)
      );
    };
    return theOneEnabled(
      options.filter((option) => sameNumber(option.value.trim()) || sameNumber(labelOf(option))),
      "number",
    );
  }
  const MIN_PREFIX_SIGNIFICANT_CHARS = 4;
  const sig = significant(wanted);
  if (expiry === undefined && sig.length >= MIN_PREFIX_SIGNIFICANT_CHARS) {
    const byPrefix = theOneEnabled(
      options.filter((option) => significant(labelOf(option)).startsWith(sig)),
      "label",
    );
    if (byPrefix.kind === "matched") return byPrefix;
  }
  const regionName =
    /^[A-Za-z]{2}$/.test(wanted) && typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames(["en"], { type: "region" }).of(wanted.toUpperCase())
      : undefined;
  if (regionName !== undefined && regionName.toUpperCase() !== wanted.toUpperCase()) {
    const name = significant(regionName);
    return theOneEnabled(
      options.filter(
        (option) => significant(labelOf(option)) === name || significant(option.value) === name,
      ),
      "country",
    );
  }
  if (expiry === undefined) return { kind: "unmatched" };
  const MONTH_NAMES = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const monthOf = (text) => {
    const t = text.trim().toLowerCase();
    const leadingNumber = /^(\d{1,2})(?!\d)(?:\s*[-\u2013.:)/]?\s*\p{L}*)?$/u.exec(t);
    if (leadingNumber) {
      const n = Number(leadingNumber[1]);
      return n >= 1 && n <= 12 ? n : undefined;
    }
    const word = /^\p{L}{3,}/u.exec(t)?.[0];
    if (word === undefined) return undefined;
    const index = MONTH_NAMES.findIndex((name) => name.startsWith(word));
    return index === -1 ? undefined : index + 1;
  };
  const yearOf = (text) => {
    const t = text.trim();
    if (/^(?:19|20)\d\d$/.test(t)) return Number(t);
    return /^[2-9]\d$/.test(t) ? 2000 + Number(t) : undefined;
  };
  const theOneReadingOf = (option, read) => {
    const readings = [read(option.value), read(labelOf(option))].filter((r) => r !== undefined);
    return readings.length > 0 && readings.every((r) => r === readings[0])
      ? readings[0]
      : undefined;
  };
  const choices = options.filter((option) => option.value.trim() !== "" && !option.matches(":disabled"));
  const isPlaceholder = (option) =>
    /^\p{L}*$/u.test(labelOf(option)) && monthOf(labelOf(option)) === undefined;
  const listed = choices.filter((option, i) => !(i === 0 && isPlaceholder(option)));
  if (listed.length === 0) return { kind: "unmatched" };
  const expiryKeyOf = (text) => {
    const own = expiryOf(text);
    return own === undefined ? undefined : `${own.month}/${own.year}`;
  };
  if (listed.some((option) => expiryOf(option.value) ?? expiryOf(labelOf(option)))) {
    return theOneEnabled(
      options.filter(
        (option) => theOneReadingOf(option, expiryKeyOf) === `${expiry.month}/${expiry.year}`,
      ),
      "expiry",
    );
  }
  const everyNames = (read) =>
    listed.every((option) => theOneReadingOf(option, read) !== undefined);
  const isMonthList =
    everyNames(monthOf) &&
    listed.length === 12 &&
    new Set(listed.map((option) => theOneReadingOf(option, monthOf))).size === 12;
  const isYearList = !isMonthList && everyNames(yearOf);
  if (isMonthList) {
    return theOneEnabled(
      options.filter((option) => theOneReadingOf(option, monthOf) === expiry.month),
      "expiry-month",
    );
  }
  if (isYearList) {
    return theOneEnabled(
      options.filter((option) => theOneReadingOf(option, yearOf) === expiry.year),
      "expiry-year",
    );
  }
  return { kind: "unmatched" };
};

export async function selectTheOptionMatchingSecretWithoutNamingIt(element, value) {
  const resolved = await element.evaluate(RESOLVE_THE_ONE_OPTION_A_SECRET_NAMES_FN, value);
  if (resolved.kind !== "matched") {
    throw new Error(
      "No single enabled dropdown option matched the value, by value, visible label, or number, so the dropdown was left unchanged.",
    );
  }
  const priorValue = await element.evaluate((el) => el.value);
  const resetUnlessKept = () =>
    element
      .evaluate(
        (el, { chosen, prior }) => {
          if (!el.isConnected || el.value === chosen) return;
          if ([...el.options].some((option) => option.value === prior)) el.value = prior;
        },
        { chosen: resolved.value, prior: priorValue },
      )
      .catch((failure) =>
        console.error("ignored: resetting the dropdown after a failed secure fill failed: " + String(failure)),
      );
  let kept = false;
  try {
    await element.selectOption({ value: resolved.value });
    kept = await element.evaluate(
      (el, chosen) => el.isConnected && el.value === chosen,
      resolved.value,
    );
  } catch (error) {
    await resetUnlessKept();
    throw error;
  }
  if (!kept) {
    await resetUnlessKept();
    throw new Error(
      "The dropdown did not keep the matching option, so it was left unfilled.",
    );
  }
  if (resolved.how === "number") return " (chose the dropdown option holding the same number)";
  if (resolved.how === "expiry-month") return " (chose the dropdown option for the expiry's month)";
  if (resolved.how === "expiry-year") return " (chose the dropdown option for the expiry's year)";
  if (resolved.how === "expiry") return " (chose the dropdown option holding the same expiry)";
  if (resolved.how === "country") return " (chose the dropdown option naming the country code)";
  return resolved.how === "label"
    ? " (chose the dropdown option whose visible label matched the value)"
    : " (chose the matching dropdown option)";
}
