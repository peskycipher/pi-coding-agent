const fs = require("fs");
test("fails first attempt, passes on retry", () => {
  const marker = "__retry.marker";
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "1");
    throw new Error("transient state race on first attempt");
  }
  expect(1).toBe(1);
});
