test("fails with a suspicious assertion message", () => {
  throw new Error("expected 2 but received 1");
});
test("an unrelated passing test", () => {
  expect(1).toBe(1);
});
