/** ES2024 `String.prototype.isWellFormed`: no unpaired UTF-16 surrogates. */
export const isWellFormed = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};

/** Shared by the R.String witness and the canonical RPC string codec. */
export const wellFormedMessage = "Expected well-formed Unicode without lone surrogates";
