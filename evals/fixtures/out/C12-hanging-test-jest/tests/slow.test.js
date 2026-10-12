test("hangs past the runner timeout", () => {
  const until = Date.now() + 60000;
  while (Date.now() < until) { /* planted hang */ }
});
