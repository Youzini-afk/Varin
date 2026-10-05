/** Tokenizer-only boundary fixture; no model or quality claims. */
export const env = {};
export const AutoTokenizer = { from_pretrained: async () => ({ encode: text => ({ length: text.length }) }) };
