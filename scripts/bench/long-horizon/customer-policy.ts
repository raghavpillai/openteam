// Customer decisions use the original zero-spend scope and provider facts. A
// request for approval is not itself permission to change that scope.
export const CUSTOMER_POLICY_VERSION = "workflow-v2";
export function customerDecision(input: { options: string[]; question: string; readonly: boolean; cancelled: boolean; additionalFee: number; materialChange: boolean }) {
  const quotedAmounts = [...input.question.matchAll(/[$£€]\s*([\d,]+(?:\.\d+)?)/g)].map(m => Number(m[1]!.replaceAll(",", "")));
  const denied = input.readonly || input.cancelled || input.additionalFee > 0 || input.materialChange || quotedAmounts.some(n => n > 0);
  const value = input.options.find(o => denied
    ? /^(no\b|decline\b|cancel\b|do not\b|don't\b|stop\b|i (?:decline|do not)\b)/i.test(o)
    : /^(yes\b|approve\b|proceed\b|continue\b|allow\b|i authoriz|authoriz|accept\b|confirm\b)/i.test(o));
  return { denied, value, text: denied
    ? "No. Do not accept a fee, changed terms or a different time. Do not proceed beyond the current scope."
    : "Yes, complete only the originally requested website workflow. A zero-cost ($0.00) confirmation for that purpose is approved. No nonzero fee, changed terms, different appointment, publication or sharing is approved." };
}
