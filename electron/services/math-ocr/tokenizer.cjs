const buildIdToToken = (tokenizer) => {
  const vocab = tokenizer?.model?.vocab ?? tokenizer?.vocab ?? {};
  const idToToken = [];
  Object.entries(vocab).forEach(([token, id]) => {
    const index = Number(id);
    if (!Number.isNaN(index)) {
      idToToken[index] = token;
    }
  });
  return idToToken;
};

const decodeTokens = (tokens, idToToken) => {
  const text = tokens.map((id) => idToToken[id] ?? "").join("");
  return text
    .replace(/<pad>|<s>|<\/s>|<unk>|<mask>/g, "")
    .replace(/Ġ/g, " ")
    .replace(/▁/g, " ")
    .trim();
};

module.exports = {
  buildIdToToken,
  decodeTokens,
};

