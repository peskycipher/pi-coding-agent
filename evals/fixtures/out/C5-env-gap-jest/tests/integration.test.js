test("reaches the fixture service", async () => {
  const url = process.env.SERVICE_URL || "http://127.0.0.1:59999/health";
  const res = await fetch(url);
  expect(res.ok).toBe(true);
});
