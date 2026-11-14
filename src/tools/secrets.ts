/**
 * The shapes of keys and tokens, which never leave a project in what it
 * publishes and are never written into a role's memory.
 */
export const KEY_SHAPES: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bhf_[A-Za-z0-9]{20,}/, "a Hugging Face token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, "a bearer token"],
];

/** What the text holds that looks like a key or token, by what it is; never the value itself. */
export const keyShapesIn = (text: string): string[] =>
  KEY_SHAPES.filter(([shape]) => shape.test(text)).map(([, label]) => label);
