test("occasionally fails", () => {
  throw new Error("deterministic regression now failing identically twice");
});
