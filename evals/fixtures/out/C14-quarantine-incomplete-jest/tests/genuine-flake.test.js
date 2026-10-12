test("genuine seeded flake", () => {
  const seed = parseInt(process.env.TEST_SEED || "7", 10);
  if (seed % 5 === 2) throw new Error("seeded nondeterminism, seed=" + seed);
  expect(1).toBe(1);
});
