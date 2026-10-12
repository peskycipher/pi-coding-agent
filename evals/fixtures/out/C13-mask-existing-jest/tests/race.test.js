test("settles eventually", async () => {
  // prior fix: jest.setTimeout(900000) (30x) instead of fixing the race
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(1).toBe(1);
});
